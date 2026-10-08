# Primeira entrega funcional

O contrato vigente é a instalação pessoal de estudante: memória com fontes e
história, estudo dos materiais atuais, obrigações e mudanças, arquivos produzidos
no cliente e ações acadêmicas aprovadas. O pacote privado de 2026-10-07 contém a
matriz de 66 cenários; não deve ser distribuído junto do código.

## Decisão de arquitetura

Manter o monólito Deno/Postgres, Auth, isolamento por dono/conexão, proveniência,
deltas idempotentes e arquivos históricos. Corrigir o adaptador Moodle, a
passagem de arquivos, a aprovação, as representações de materiais e a atenção.
Retirar OAuth, leituras e escritas Google próprias e os respectivos controles
da interface. Os snapshots Google preservados continuam acessíveis por um leitor
genérico; nenhuma revogação ou exclusão de conta é efeito dessa retirada.

Autoria ocorre nas ferramentas do cliente. `hub_import_artifact` recebe o objeto
de arquivo do host, valida o destino de download, limita bytes e preserva hash,
nome original e nome seguro. URL temporária não é gravada. A primeira cadeia
aceita DOCX, PPTX, PDF e texto UTF-8 até 16 MiB. Esse limite é independente do teto
da atividade Moodle, que pode ser menor. O armazenamento atual reaproveita
`hub_files`; migração de binários para objetos privados requer reconciliação,
comparação de hashes e restauração antes de substituir o armazenamento.

O cliente pode apresentar `file` como caminho absoluto do arquivo em seu próprio
ambiente. Nesse caso, o upload nativo transforma esse caminho no objeto recebido
pelo servidor; não confundir o parâmetro do cliente com o contrato MCP do servidor.
Destinos de download são hosts exatos observados no transporte nativo, sem liberar
o sufixo de um provedor inteiro. DNS privado, redirecionamentos e URLs com credenciais
continuam recusados.

`hub_prepare_moodle_action` produz uma intenção imutável com conta, curso,
atividade, texto, anexos, declaração e precondições. O titular revisa a ação
inteira na interface autenticada. O servidor não aceita um argumento do modelo
como consentimento. `hub_execute_moodle_action` revalida a intenção, consome a
aprovação uma vez e preserva as etapas e o recibo. Um resultado incerto impede
reenvio automático. Consultar `hub_action` antes de qualquer reconciliação.

A aprovação tem validade limitada. Quando vence sem ser consumida, a interface
permite revisar e autorizar novamente a mesma versão ainda válida, incluindo nova
aceitação da declaração exigida. Se a própria preparação venceu, é preciso preparar
uma nova versão. Nenhuma dessas etapas renova a aprovação automaticamente.

As operações implementadas são tópico, resposta ao post selecionado e entrega
de arquivo individual. Configurações não demonstradas, inclusive assentimento
de grupo, são recusadas explicitamente. A consulta Moodle do status individual
exige a política específica descrita em [STATUS-PROPRIO.md](STATUS-PROPRIO.md),
desativada por padrão e ligada à conta, conexão e época da credencial. Seus
efeitos técnicos auditados precisam ser aceitos separadamente. A permissão de
consulta não autoriza upload nem entrega. Prova de Lab não amplia consentimento.

DOCX/HTML têm extração estruturada e fila durável. O executor local roda fora da
requisição MCP, com timeout e preservação da melhor representação do mesmo hash.
Vídeo usa ferramentas locais separadas. Uma extração concluída não comprova
leitura humana; fala transcrita não comprova análise visual. Não existe executor
remoto nem agendamento recorrente ativo por efeito desta implementação.

Cadastro público, outros LMS, papéis docentes no produto e marketplace ficam
para depois. Isso não reduz os critérios de isolamento, recuperação, fóruns,
submissão, materiais e continuidade da entrega pessoal.

## Gates e estados de prova

1. TypeScript, testes de domínio/SQL/SDK, instalação nova, isolamento e revisão
   dos arquivos distribuídos.
2. Moodle Lab com credencial de estudante: efeitos reais, readback independente,
   permissões negativas e inspeção visual. Contas sintéticas e origem guardada.
3. Exportação real do conector e passagem de bytes; prova completa pelo host
   ChatGPT tem estado separado do SDK local.
4. Leitura institucional autorizada com versão, origem, hash e lacunas. Nenhuma
   ação de teste na instituição.
5. Reconciliação e backup/restore antes de publicação ou virada. A instalação,
   atualização de ferramentas e conversa nova são verificações próprias.

`STATUS.md` é o checkpoint público; evidências detalhadas e matriz por nível
ficam em `.private/entrega-1/`. Um gate pendente ou bloqueado impede declarar R1
completa. Os critérios e provas anteriores permanecem no histórico Git.
