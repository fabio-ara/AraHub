# Armazenamento e economia de espaço

O AraHub guarda referências, memória, arquivos e representações. Esses elementos
têm papéis diferentes. Uma referência diz onde um material se encaixa; o binário
conserva seus bytes; uma extração descreve o que foi possível obter dele.

## Onde os bytes ficam

A implementação corrente conserva binários no PostgreSQL, em colunas `bytea`.
Ela não usa buckets do serviço **Supabase Storage**. Por isso, reduzir esses
binários economiza carga do banco, e não uma cota de objetos que o aplicativo
estivesse consumindo. Banco, Storage, tráfego de saída e invocações são medidas
distintas na operação da infraestrutura.

Os dados são separados por dono. Dentro da conta, `hub_files` conserva os
metadados e vínculos acadêmicos; `hub_file_blobs` conserva os conteúdos completos
reutilizáveis. A view `hub_file_contents` apresenta os bytes resolvidos para os
leitores, aplicando as políticas das tabelas subjacentes com `security_invoker`.

## Exemplo de deduplicação

Imagine que o mesmo PDF de 4 MB seja material de três atividades. As três
referências continuam existindo, pois seus nomes, relações e origens podem ser
diferentes. Se os bytes forem iguais, a conta pode guardar um único conteúdo de
4 MB em vez de três cópias. Se uma versão do PDF mudar, seu hash muda e a nova
versão permanece separada.

Outro usuário com o mesmo PDF mantém seu próprio conteúdo. A chave inclui dono e
SHA-256. Isso evita usar a deduplicação para descobrir se outra pessoa possui um
arquivo, e evita misturar direitos ou ciclos de exclusão entre contas.

## Como a gravação funciona

Os caminhos de importação, preservação Moodle e recepção de artefatos concluem a
gravação em transação. Arquivos grandes são enviados ao banco em partes limitadas
para respeitar a memória do runtime. Antes de compactar a representação física,
o sistema confere tamanho e SHA-256 dos bytes armazenados.

`hub_compact_file` bloqueia a referência, valida o conteúdo e insere ou reutiliza
o objeto do mesmo dono. Confere também igualdade dos bytes, além do hash. Só
depois troca o payload temporário pela referência ao objeto. Uma falha desfaz a
transação. Repetir a compactação de uma referência já compactada não duplica o
conteúdo.

O termo “compactar” aqui significa remover cópias físicas repetidas. Não converte
o PDF, não reduz a qualidade de imagens e não altera os bytes originais. Compressão
interna do PostgreSQL é um mecanismo separado.

## Atualizar uma instalação existente

A migration é aditiva: cria estrutura e leitor compatível sem alterar os arquivos
existentes. A ordem de implantação é importante:

1. Faça e verifique uma cópia de recuperação da aplicação e do cofre.
2. Aplique a migration que cria objetos, view e funções de manutenção.
3. Implante o backend que lê `hub_file_contents` e compacta novas gravações.
4. Compacte os arquivos antigos por proprietário, usando a função autenticada.
5. Compare metadados, hashes dos bytes, referências e métricas antes/depois.

O código antigo que lê diretamente `hub_files.binary_content` não recupera um
objeto já compactado. Depois da conversão, um rollback de código também precisa
reidratar os bytes ou usar uma versão que conheça a view. Não basta apontar a Edge
Function para um commit anterior.

No banco local exclusivo, há manutenção explícita:

```powershell
deno task storage:compact
deno task storage:compact --apply
```

A primeira chamada inspeciona sem alterar; a segunda compacta registros íntegros
e recolhe objetos sem referências. O script é restrito ao banco local do AraHub.
Na produção, o operador deve executar a transformação no alvo conferido, com
backup e comparação de preservação. Não copie credenciais de produção para
transformar um teste local em operação remota inadvertidamente.

## Interpretar `hub_usage`

| Campo | O que mede |
| --- | --- |
| `declared_file_bytes` | Soma dos tamanhos declarados das referências. |
| `preserved_binary_bytes` | Soma dos bytes disponíveis por referência; repete um objeto quando há várias referências. |
| `stored_binary_bytes` | Bytes brutos ainda na área de gravação mais conteúdos armazenados uma vez em objetos. |
| `deduplicated_bytes` | Diferença positiva entre bytes por referência e bytes armazenados. |
| `unique_binary_objects` | Quantidade de objetos compactados da conta. |
| `extracted_text_utf8_bytes` | Tamanho lógico das representações textuais em UTF-8. |

Os tamanhos são strings decimais para não perder precisão. Esses números não
incluem todos os custos de índices, WAL, Auth, tabelas técnicas ou compressão
TOAST. Não são a fatura nem o espaço físico exato do projeto. O PostgreSQL pode
reutilizar páginas liberadas sem reduzir imediatamente o tamanho físico do banco.

## Exclusão e objetos sem referências

Apagar uma referência não autoriza apagar o objeto enquanto outra referência o
utiliza. A chave estrangeira impede essa perda. A função autenticada
`hub_prune_file_blobs()` remove somente objetos do dono que não têm referências.
Ela pode ser chamada em manutenção explícita; não há cron de limpeza criado por
esta funcionalidade. Exclusão da conta também alcança seus objetos pelo vínculo
com a identidade.

Preservação de versões continua sendo a regra. Não existe exclusão automática de
originais baseada apenas em idade, desuso ou obtenção de uma síntese. Para economizar
mais, selecione o que precisa ser preservado e use referências quando uma cópia
não for necessária. O sistema não trata uma URL externa como prova de backup.

## Limites de escala

Deduplicação economiza conteúdo repetido; arquivos diferentes continuam ocupando
espaço. Ela não é uma cota por usuário nem uma barreira completa contra abuso.
Uma abertura ampla exige acompanhar limites, volume por conta e capacidade do
plano. Não há garantia de suporte a um número ilimitado de pessoas.

A pausa por inatividade do plano Free é independente dessa economia. Leia
[operação e recuperação](operacao-e-recuperacao.md).
