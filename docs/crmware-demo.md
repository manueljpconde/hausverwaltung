# Demo CrmWare Portugal

Guia operacional da demonstração criada por `prisma/seed-crmware-demo.ts`. Todos os nomes, contactos, NIF, IBAN, documentos e movimentos são sintéticos. A data funcional está fixada em 26 de setembro de 2026 e o histórico cobre outubro de 2024 a setembro de 2026.

## Matriz funcional

| Capacidade | Estado | Evidência técnica | Dados e fluxo demonstrável | Perfis |
| --- | --- | --- | --- | --- |
| Isolamento por organização | Confirmado | `Tenant`; `tenantId` nos modelos; filtros nas server actions | Três organizações independentes; validação de relações entre imóvel, edifício, fração, contrato, proprietário e pessoa | Todos, dentro do respetivo tenant |
| Utilizadores e RBAC | Confirmado | `UserRole`, `src/lib/rbac.ts` | Login real; administração, gestão, contabilidade, conselho, proprietário, inquilino e prestador | `ADMIN`, `VERWALTER`, `BUCHHALTUNG`, `BEIRAT`, `EIGENTUEMER`, `MIETER`, `HANDWERKER` |
| Imóveis, edifícios e frações | Confirmado | `Property`, `Building`, `Unit`; gestão `MIET`/`WEG` | Pesquisa e consulta de património misto, arrendamento e condomínio | Escrita: admin/gestão/contabilidade; consulta conforme páginas autorizadas |
| Proprietários e condóminos | Confirmado | `Person`, `Owner`; portal por `personId` | Frações, permilagens, deliberações e documentos atribuídos à pessoa | Gestão e proprietário |
| Contratos de arrendamento | Confirmado | `Lease`, `Renter`, `RentComponent`, `Deposit`, `RentAdjustment` | Contratos ativos, futuros e terminados inferidos por datas; rendas, caução e componentes | Gestão, contabilidade e inquilino no portal |
| Cobranças e pagamentos | Confirmado | `Charge`, `Payment`, `DunningNotice`, `SepaMandate`, `Account` | 24 meses de movimentos, valores liquidados e vencidos, avisos de pagamento e comprovativos associados | Gestão, contabilidade e inquilino para os seus contratos |
| Condomínio | Confirmado | `Meeting`, `AgendaItem`, `Resolution`, `EconomicPlan`, `Reserve` | Assembleias, ordem de trabalhos, deliberações, orçamento e fundo comum de reserva | Gestão; proprietário consulta unidades e deliberações |
| Manutenção | Confirmado | `Ticket`, `Contractor`, `MaintenanceContract`; notificações no fluxo | Ocorrência, atribuição, prioridade, estado, tempo, prestador e manutenção preventiva | Gestão; inquilino reporta e acompanha as próprias ocorrências |
| Documentos | Confirmado | `Document`, storage local, rota `/api/documents/[id]` | PDF, PNG, JPEG e XLSX não vazios, ligados a imóvel, fração e pessoa; comprovativos ligados a pagamentos | Gestão; portal vê apenas documentos ligados expressamente à pessoa |
| Tarefas, calendário e notificações | Confirmado | `Task`, `Appointment`, `Notification` | Pendentes/concluídas, prazos, visitas, assembleias e notificações lidas/não lidas | Utilizadores autenticados conforme a área |
| Auditoria e correio | Parcialmente suportado | `AuditLog`, `EmailMessage`, `EmailAttachment` | Histórico sintético de operações; modelo de mensagens e anexos | Gestão; envio real depende de SMTP configurado |
| Mercado português | Parcialmente suportado | `Tenant.market = PT`, locale `pt`, campos `custom` | Moradas, nomes, NIF e IBAN sintéticos; textos e datas PT | Todos |
| Portefólio de senhorio | Não suportado como fronteira de acesso | Não existe modelo `Portfolio` nem ACL por proprietário | Senhorios são `Person` + `Owner`; as relações podem ser mostradas, mas não existe isolamento por portefólio de senhorio | Proprietário apenas através das regras gerais do portal |

## Cenários e métricas

| Métrica | Gestão mista | Condomínios | Arrendamento |
| --- | ---: | ---: | ---: |
| Utilizadores internos | 10 | 8 | 4 |
| Condomínios | 5 | 8 | 0 |
| Imóveis de arrendamento | 20 | 0 | 12 |
| Frações | 115 | 225 | 20 |
| Condóminos/proprietários | 90 + 7 senhorios | 185 | 1 senhorio |
| Contratos ativos / futuros / terminados | 20 / 4 / 4 | 0 / 0 / 0 | 14 / 3 / 5 |
| Contratos em incumprimento | 3 | 0 | 2 |
| Frações disponíveis | 4 | 0 | 3 |
| Movimentos financeiros | 450 | 750 | 300 |
| Ocorrências | 28 | 38 | 18 |
| Prestadores | 8 | 12 | 6 |
| Assembleias / deliberações | 8 / 18 | 12 / 30 | 0 / 0 |
| Documentos | 140 | 225 | 90 |

Os valores usam os pontos médios pedidos, com dois ajustes de coerência: quatro contratos futuros no cenário misto explicam as 28 frações arrendáveis; o cenário de arrendamento usa 20 frações para acomodar 14 contratos ativos, três futuros e três frações disponíveis. Cerca de 75% das ocorrências estão concluídas, 17% estão pendentes e 8% têm prioridade excecional.

## Matriz de personas

| Persona | Dados visíveis | Ações permitidas | Ações proibidas ou não demonstradas |
| --- | --- | --- | --- |
| Administrador | Todo o tenant; configuração e utilizadores | Todas as operações da organização | Dados de outro tenant |
| Gestor (`VERWALTER`) | Dados operacionais do tenant | Criar e alterar imóveis, pessoas, contratos, ocorrências, documentos e utilizadores não administrativos | Criar admin/gestor; operar noutro tenant |
| Contabilidade (`BUCHHALTUNG`) | Dados financeiros e operacionais do tenant | Escrita abrangida por `requireWriter`; cobranças, pagamentos e documentos | Administração de instância |
| Conselho (`BEIRAT`) | Áreas cujo acesso de página aceite o papel | Consulta | Escrita de dados mestres |
| Proprietário/condómino (`EIGENTUEMER`) | Frações próprias, deliberações dos respetivos imóveis e documentos ligados à pessoa | Consulta no portal | Escrita administrativa; documentos internos sem `personId` |
| Inquilino (`MIETER`) | Contratos próprios, valores, pagamentos, documentos pessoais e ocorrências reportadas | Reportar ocorrência e acompanhar estado | Outros contratos, imóveis ou documentos |
| Prestador (`HANDWERKER`) | Apenas áreas explicitamente autorizadas pelo routing/RBAC | Login real para validar o papel | Não existe portal funcional dedicado ao prestador |

## Credenciais

Palavra-passe comum de demonstração: `CrmWareDemo!2026`.

| Cenário | Administrador | Proprietário | Inquilino | Prestador |
| --- | --- | --- | --- | --- |
| Misto | `equipa.001@mista.crmware-demo.example` | `portal.proprietario.001@mista.crmware-demo.example` | `portal.inquilino.001@mista.crmware-demo.example` | `portal.prestador.001@mista.crmware-demo.example` |
| Condomínios | `equipa.001@condominios.crmware-demo.example` | `portal.proprietario.001@condominios.crmware-demo.example` | Não aplicável | `portal.prestador.001@condominios.crmware-demo.example` |
| Arrendamento | `equipa.001@arrendamento.crmware-demo.example` | `portal.proprietario.001@arrendamento.crmware-demo.example` | `portal.inquilino.001@arrendamento.crmware-demo.example` | `portal.prestador.001@arrendamento.crmware-demo.example` |

## Execução e validação

Com PostgreSQL migrado e `DATABASE_URL` definido:

```bash
npm run db:seed:crmware
npm run db:validate:crmware
```

O seed é determinístico e substitui apenas tenants `isDemo` com os três nomes `CrmWare Demo PT - ...`. A validação falha se os volumes divergirem, o histórico financeiro não cobrir 24 meses, um documento estiver vazio/em falta ou uma relação principal cruzar tenants. Os ficheiros são gravados em `storage/documents/` com o prefixo `crmware-demo-<cenário>-`.

## Guião de demonstração

1. Entrar como administrador do cenário misto e mostrar o painel, os 25 imóveis e a separação entre arrendamento e condomínio.
2. Abrir um imóvel de arrendamento, percorrer frações e mostrar contratos ativos, futuros, terminados e a caução.
3. Abrir finanças, comparar pagamentos liquidados com rendas vencidas e consultar o aviso de pagamento de um contrato em incumprimento.
4. Abrir uma ocorrência pendente, mostrar prioridade, prestador, responsável, prazo e tempo registado; concluir a ocorrência e evidenciar a notificação ao inquilino.
5. Abrir documentos, filtrar categorias e descarregar exemplos PDF, imagem e XLSX; mostrar uma fatura associada a um pagamento.
6. Abrir um condomínio, mostrar permilagens, orçamento, fundo comum de reserva, assembleia, ordem de trabalhos e deliberações.
7. Terminar sessão e entrar como condómino; mostrar apenas frações próprias, deliberações e documentos ligados à pessoa.
8. Entrar como inquilino; mostrar contrato, valores em aberto, histórico de pagamentos, documentos pessoais e reporte de ocorrência.
9. Trocar para os cenários exclusivamente condomínio e arrendamento para demonstrar que a navegação e os dados refletem modelos de negócio distintos.
10. Executar `npm run db:validate:crmware` e apresentar os indicadores automáticos dos três cenários.

## Limitações confirmadas

- A aplicação garante isolamento por organização; não existe isolamento por portefólio de senhorio.
- `Lease` não tem estado próprio. Ativo, futuro e terminado são inferidos por `startDate` e `endDate`; incumprimento da demo é marcado em `custom` e comprovado por cobrança vencida.
- `Unit` não tem estado de disponibilidade/manutenção. Disponibilidade é inferida pela ausência de contrato ativo ou futuro.
- Ocorrências não têm estados cancelado ou reaberto; apenas aberto, em curso, em espera e concluído.
- Assembleias não têm estado cancelado; apenas planeada e realizada.
- Documentos não têm versionamento, validade, nível de confidencialidade ou retenção próprios.
- O papel de senhorio é representado por proprietário (`EIGENTUEMER`); não existe papel específico.
- Existe papel de prestador, mas não existe um portal funcional dedicado ao prestador.
- NIF e alguns metadados portugueses usam campos `custom`; não existe validação fiscal portuguesa estrutural no schema.
- O seed não demonstra envio real de correio, sincronização bancária, faturação fiscal portuguesa ou integrações externas que dependam de credenciais.
