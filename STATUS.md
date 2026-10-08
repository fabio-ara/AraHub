# Estado do AraHub

Atualizado em 2026-10-08. Primeira entrega em implementação na branch `entrega-1`.
**R1 ainda não concluída.** Backend publicado 0.2.2 e plugin pessoal 1.1.1; correções 0.2.3
validadas localmente, publicação em preparação. Contrato: [docs/ENTREGA-1.md](docs/ENTREGA-1.md).

A ponte nativa ChatGPT/Google → AraHub → Moodle Lab passou. Dois DOCX atravessaram
os arquivos do host com nome, bytes e hash conferidos. Pela App ChatGPT e identidade
OAuth reais, o estudante sintético publicou tópico/anexo, respondeu ao post correto e
finalizou uma entrega. Os recibos e a interface normal do Moodle confirmaram os efeitos.
Nenhum teste mutável foi feito na universidade.

Aprovação vencida foi recusada pelo servidor antes de qualquer etapa da entrega. A UI
agora informa a expiração e permite nova revisão da mesma versão, exigindo novamente
a declaração de autoria. Estados incertos e resultados consumidos continuam sem reenvio.
Outro dono foi recusado no endpoint real de homologação; revogação foi testada com sessão
nativa sintética e o verificador real. App/OAuth/callback/túnel temporários foram encerrados
após a prova, preservando o Lab local, a conta e o plugin pessoais.

O DOCX gerado no ChatGPT foi enfileirado pelo cliente real, processado por CLI local
separado e recuperado no cliente com tabela 2×2 e localizadores por célula. Isso não prova
um executor autônomo hospedado. A Skill passou a orientar navegação por estrutura,
seções, livros/páginas, fóruns e deeplinks, distinguindo acesso de visibilidade no menu.
Uma rota institucional foi confirmada somente por leitura, inclusive o link dentro do livro.

Validação: suíte geral com 230 aprovados, nenhuma falha e dois ignorados; tipos e Edge passaram.
Após a correção de expiração, sete testes da prévia e 13 da autoridade passaram, além dos tipos
web e da interação/inspeção visual da UI. As provas anteriores de duas versões Moodle,
isolamento, negativos, recuperação e histórico permanecem válidas em seus escopos.

Matriz: 63 cenários aprovados de 66; MAT-01, MAT-02 e OPS-04 ainda abertos. Homologação,
importação privada dos 19 materiais e virada METD já têm autorização específica, nessa ordem.
A homologação terminou. O preflight de materiais detectou novidades legítimas na conta
hospedada e recusou o baseline antigo antes de escrever. Backup/reconciliação atuais estão
em andamento, sem apagar nem sobrescrever essas novidades. Depois, aplicar e verificar
materiais e reconciliar o delta da fonte antes de atualizar o Projeto METD.

AraHub será a memória cotidiana principal dos novos registros após a virada verificada;
Git continuará como história e recuperação. Materiais/fontes, biografia, preferências,
versões e recibos antigos permanecem preservados. As escritas Google próprias foram
retiradas. Status de assignment na universidade continua bloqueado por efeitos indiretos;
a homologação sintética não altera essa política. Recorrência e processamento hospedados
têm escopos operacionais próprios. Restauração do Auth gerenciado não foi demonstrada.

Pacote privado, ZIP, evidências e credenciais ficam fora do Git. Checkpoint operacional:
`.private/entrega-1/STATUS.md`; prova nativa: `.private/entrega-1/host-live/homologation.json`.
