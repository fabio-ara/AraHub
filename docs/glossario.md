# Glossário

| Termo | Significado no AraHub |
| --- | --- |
| Instalação ou instância | Um conjunto próprio de interface, backend, identidade e banco. |
| Proprietário ou dono | Identidade autenticada à qual um registro pertence; não é um campo livre escolhido pelo cliente. |
| Conexão | Vínculo entre a conta AraHub e uma conta/origem externa, com estado e credencial próprios. |
| Cliente MCP | Aplicativo que descobre e invoca ferramentas do servidor AraHub. |
| MCP | Protocolo de comunicação para ferramentas e contexto; não é autorização irrestrita. |
| OAuth | Fluxo de autorização em que o cliente obtém acesso sem receber a senha da pessoa. |
| PKCE | Proteção que vincula o início do login à troca do código de retorno; por isso links podem depender do navegador inicial. |
| Sessão | Vínculo de autenticação ativo, verificável e revogável no servidor. |
| RLS | Segurança por linha no PostgreSQL: regras que filtram quais registros um papel pode ler ou alterar. |
| Proveniência | Informação sobre origem, localizador, data e versão que permite rastrear uma afirmação. |
| Entidade | Objeto identificado no grafo, como curso, atividade, discussão ou recurso. |
| Contexto | Unidade de retomada de trabalho que agrupa memória e vínculos relevantes. |
| Observação | Conteúdo obtido da fonte em um momento, com cobertura declarada. |
| Delta | Registro versionado de acréscimo, decisão, relato ou correção de memória. |
| Idempotência | Propriedade de repetir a mesma tentativa lógica sem duplicar seu efeito. |
| Versão esperada | Número usado para recusar uma atualização que parte de um estado já ultrapassado. |
| Hash SHA-256 | Impressão digital calculada dos bytes; ajuda a verificar integridade e igualdade de conteúdo. |
| Binário | Sequência original de bytes de um arquivo, independentemente da extração textual. |
| Deduplicação | Reaproveitamento de bytes idênticos, conservando referências distintas; no AraHub fica dentro de uma conta. |
| Representação | Texto, transcrição, síntese ou outra forma derivada de um original, com evidência própria. |
| Cobertura | Descrição do que foi efetivamente observado ou processado; parcial não significa completo. |
| Relato (`user_report`) | Informação comunicada pela pessoa, distinta de uma observação institucional. |
| Incerto | Estado em que o resultado externo não está confirmado e não pode ser reenviado automaticamente. |
| PostgreSQL | Banco relacional que guarda memória, referências e bytes preservados nesta implementação. |
| Supabase Storage | Serviço de armazenamento de objetos/buckets; não é o destino dos binários na implementação corrente. |
| Egress | Tráfego de dados que sai da infraestrutura; é medido separadamente de bytes armazenados. |
| SMTP | Protocolo de envio de e-mail usado pelo serviço de identidade para links e recuperação. |
| Fixture | Dado controlado de teste, que não deve ser apresentado como prova de acesso real à instituição. |
| Gate | Verificação necessária antes de entregar uma mudança; seu alcance deve ser declarado. |

Leia a [arquitetura](arquitetura.md) para ver como esses conceitos se relacionam e
o [guia do usuário](guia-do-usuario.md) para exemplos de uso.
