# AraHub

O AraHub reúne fontes, arquivos e memória acadêmica para ajudar uma pessoa a retomar
seu trabalho entre conversas com um assistente. Ele conecta contas Moodle, conserva
materiais e registra acontecimentos com sua origem: um relato de entrega continua
distinguível da confirmação obtida na instituição.

**[Documentação oficial — comece por aqui](docs/README.md)**

O uso cotidiano ocorre em um cliente MCP, como o ChatGPT com o plugin AraHub. A
interface web permite entrar, conectar ou renovar o Moodle, consultar materiais e
revisar ações acadêmicas. O código é distribuído sob [MIT](LICENSE). Cada pessoa
mantém sua própria memória e suas conexões; a licença não torna públicos os dados
nem concede direitos sobre materiais das instituições.

| Quero… | Percurso |
| --- | --- |
| Entender a proposta | [Visão do produto](docs/visao-do-produto.md) |
| Usar uma conta | [Guia do usuário](docs/guia-do-usuario.md) e [acesso e identidade](docs/acesso-e-identidade.md) |
| Conectar meu assistente | [Instalação do MCP](docs/INSTALAR-MCP-SEM-CODEX.md) |
| Hospedar para outras pessoas | [Instalação e configuração](docs/guia-de-instalacao.md) |
| Economizar espaço | [Armazenamento](docs/armazenamento.md) |
| Entender um aviso de pausa | [Operação e recuperação](docs/operacao-e-recuperacao.md) |
| Contribuir | [CONTRIBUTING](CONTRIBUTING.md) e [guia do desenvolvedor](docs/guia-do-desenvolvedor.md) |

O AraHub pode ser instalado por outras pessoas e configurado para contas por
convite ou cadastro aberto, com os métodos de identidade habilitados no Supabase.
Uma instalação própria tem seus próprios dados, credenciais e limites. A
[instância inicial](https://fabio-ara.github.io/AraHub/) tem sua condição efetiva
registrada em [STATUS](STATUS.md); código configurável não significa que todos os
provedores estejam ativados nela.

O backend usa PostgreSQL, autenticação Supabase e MCP por HTTP. A interface estática
pode ser publicada no GitHub Pages. O armazenamento reaproveita o conteúdo binário
idêntico dentro de uma conta, conservando cada referência e versão. A deduplicação
não compartilha arquivos entre usuários. Consulte as
[capacidades e limites](docs/capacidades-e-limites.md) para distinguir o que está
implementado do que exige configuração ou homologação.

## Executar localmente

Requer Deno 2.9.3 e Docker com o banco exclusivo do AraHub disponível. A configuração
de produção está exemplificada em [.env.example](.env.example); o modo abaixo usa
identidade sintética e não acessa a instituição.

```powershell
docker compose -p arahub up -d --wait
deno task db:setup
deno task web:build
deno task check
deno task test
$env:APP_MODE='synthetic'
deno task dev
```

Abra `http://127.0.0.1:8787`. A prova local não substitui login real, consentimento
OAuth nem acesso à instituição. [Instalação](docs/guia-de-instalacao.md),
[arquitetura](docs/arquitetura.md) e [privacidade](docs/privacidade.md) explicam as
fronteiras. O acompanhamento recorrente exige configuração e autorização próprias;
uma conversa encerrada não deixa o assistente monitorando o Moodle.

[Licenças de terceiros](THIRD_PARTY_NOTICES.md) · [Estado da entrega](STATUS.md) ·
[Inventário da documentação](docs/inventario-documentacao.md)
