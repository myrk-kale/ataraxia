# Ataraxia — Especificação do Sistema

**Versão:** 1.1 (atualização de design system)  
**Data:** 11 de novembro de 2026  
**Estado:** Proposta de implementação  
**Referência visual e comportamental:** [Protótipo interativo do Ataraxia](https://concierge-workspace-poc-20261111.mikael3305.chatgpt.site)

> **Papel do protótipo.** O protótipo define a direção visual, a navegação e os fluxos de interação. Seus agentes, respostas, repositórios e execução de terminal são simulados. Esta especificação estabelece os comportamentos reais necessários. Em caso de divergência de aparência, o protótipo é a referência de UX; em caso de divergência de comportamento, os requisitos abaixo prevalecem.

## 1. Visão geral

O **Ataraxia** é um ambiente desktop para desenvolvimento de software assistido por agentes. Permite conversar com agentes de programação, consultar e editar arquivos, examinar alterações de Git por importância, discutir decisões derivadas do trabalho do agente e explorar fluxos do código em diagramas interativos.

Seu princípio operacional é: **os agentes produzem código e artefatos explicativos; a pessoa desenvolvedora compreende, questiona, aprova e orienta o trabalho sem perder o contexto.**

### 1.1 Objetivos

- Integrar Codex, Claude Code e, quando possível, outros agentes em uma experiência uniforme.
- Transformar checkpoints de trabalho em artefatos úteis: *decisions*, prioridades de review e flows.
- Permitir revisão por arquivo ou componente sem uma interface saturada de controles.
- Preservar histórico de sessões, discussões, avaliações, versões e proveniência.
- Permitir investigações contextuais via BTW sem interferir inadvertidamente na sessão principal.
- Entregar acabamento visual profissional desde o primeiro incremento implementado.

### 1.2 Não objetivos iniciais

- Substituir um IDE completo com depuração avançada, refatorações de linguagem ou marketplace de extensões.
- Automatizar a aplicação de mudanças sem confirmação quando o usuário pede apenas uma explicação.
- Garantir suporte idêntico a todos os recursos de todos os agentes; diferenças de protocolo devem ser explicitadas.
- Implementar API Explorer/Swagger inteligente no MVP.

## 2. Experiência e navegação

A interface é **minimalista, imersiva e orientada ao teclado**. Não há sidebar global permanente. Um controle discreto de pontos próximo ao centro da borda direita indica espaços disponíveis, e transições curtas preservam a continuidade ao navegar entre eles.

### 2.1 Espaços principais

| Espaço | Responsabilidade | Comportamento principal |
|---|---|---|
| **Chat** | Sessão de desenvolvimento com um agente | Mensagens, ferramentas, progresso e artefatos associados à execução |
| **Code** | Leitura, edição e revisão do repositório | Uma única janela; seletor local entre componentes, arquivos alterados e árvore do projeto |
| **Decisions** | Julgamento e discussão de escolhas | Uma decisão por vez; tipo explícito; aprovação/rejeição; discussão persistente por decisão |
| **Flow** | Exploração visual do código | Diagrama gerado por preset de prompt, com instruções adicionais por execução |

Os artefatos pertencem a uma sessão de Chat e a um checkpoint. O Chat deve mostrar essa relação hierárquica. Uma gaveta temporária à direita lista os artefatos da sessão, acessível por atalho, sem poluir a tela principal.

### 2.2 Navegação e atalhos

| Atalho | Ação |
|---|---|
| `Shift + ←/→` | Espaço anterior/próximo |
| `Space` (fora de campos de texto) ou `Ctrl/Cmd + K` | Abrir paleta BTW contextual |
| `Esc` | Fechar overlay ou cancelar ação contextual |
| `Shift + A` | Abrir gaveta temporária de artefatos |
| `Ctrl + J` ou `Ctrl + \`` | Alternar terminal inferior retrátil |
| `V` em Code/Review | Alternar versão atual e anterior no mesmo viewport |
| `J/K` em filas | Navegar entre itens, desde que não haja editor/campo focado |
| `C` em Decisions/Code | Abrir composição contextual de comentário |

Os atalhos devem ser configuráveis no futuro e nunca capturados indevidamente durante digitação, IME ou edição de código. Uma legenda de atalhos poderá ser acessada sob demanda.

### 2.3 Header global

Manter somente o header global. Ele deve expor, com densidade reduzida:

- Seletor de **repositório** e **worktree**.
- **Novo chat**, que cria novo contexto de sessão, sem apagar históricos.
- Acesso às **sessões do repositório**, agrupadas por worktree.
- Ação para abrir/fechar o **terminal** inferior.

No Flow não há segundo header. Os controles de geração flutuam sobre o canvas.

## 3. Chat e sessões

Cada chat representa uma sessão/contexto de execução e está associado a um repositório e uma worktree. Deve ser possível iniciar um novo chat, reabrir sessões anteriores, acompanhar execução do agente, preservar as mensagens e navegar aos artefatos gerados.

Mensagens e chamadas de ferramentas devem ser exibidas de modo legível, com detalhes expansíveis; saídas extensas não devem dominar a conversa. Erros de agente, interrupções e solicitações de permissão precisam de estados explícitos.

**Modelo de proveniência:** `Repository → Worktree → Chat Session → Checkpoints → Artifacts`. Um artifact pode ter referências a vários arquivos e múltiplos updates, mas sua origem permanece verificável.

## 4. Code: arquivos e revisão

O espaço Code reúne leitura, edição e review, sem criar uma janela global separada.

### 4.1 Navegador local

Um seletor compacto, no topo da lista lateral, alterna entre:

1. **Components:** fila de componentes ou unidades de alteração priorizadas.
2. **Changed files:** lista **vertical**, um arquivo por linha, com indicador de alteração.
3. **Project tree:** árvore hierárquica navegável, para leitura/edição sem apresentação de diff.

A seleção deve preservar, sempre que viável, o arquivo aberto e o ponto de leitura. A lista lateral é persistente no espaço Code e não deve desaparecer ao mudar a visualização.

### 4.2 Editor

- Exibir conteúdo do arquivo com **syntax highlighting**, números de linha e scroll apropriado.
- Permitir leitura e edição locais, com estado de arquivo modificado e salvamento explícito ou configurado.
- Evitar introduzir barras, cards ou painéis que reduzam a área disponível para código.
- Respeitar alterações externas no arquivo: avisar quando houver conflito antes de sobrescrever.

### 4.3 Revisão

- O sistema identifica mudanças a partir de um par de revisões Git explícito: base e head/checkpoint.
- No modo de revisão, exibir **uma versão de código por vez**; `V` alterna entre versão atual e versão anterior do mesmo arquivo/região.
- Prioridade por componente/arquivo deve refletir impacto, complexidade e risco, com justificativa acessível.
- Comentários e notas devem ser iniciados via atalho e editor contextual temporário, não por formulários permanentes.
- Revisão de implementação e aprovação de uma decisão são julgamentos **independentes**.

## 5. Decisions

Decisions são **decisões de engenharia**, não necessariamente arquiteturais. Tipos possíveis incluem contrato de API, integridade de dados, comportamento, segurança, dependências, desempenho, organização de código, UX e outros definidos pelo sistema. O tipo deve aparecer de forma discreta e legível na visualização.

Cada decisão contém:

- Identificador, tipo, título/pergunta, resumo, contexto, justificativa e alternativas quando pertinentes.
- Arquivos, linhas e checkpoint de origem.
- Estado: `pending`, `approved`, `rejected`, `superseded` (ou equivalente extensível).
- Discussão persistente com mensagens, participantes, timestamps e anexos de código.
- Histórico de versões/revisões da decisão e relação com mudanças subsequentes.

O usuário pode aprovar, rejeitar, comentar ou pedir uma explicação adicional. **Perguntar não é autorização para modificar arquivos.** Solicitações de alteração exigem ação inequívoca. A mesma decisão pode ser discutida após aprovação ou rejeição.

## 6. BTW: subagente contextual global

O **BTW** é invocado exclusivamente por atalho, sem botão, menu ou indicador persistente no chrome da aplicação. Sua apresentação inicial é uma paleta de entrada estilo Spotlight: discreta, centralizada e minimalista.

### 6.1 Contexto e comportamento

- Captura o contexto atual: repositório, worktree, sessão, espaço, item selecionado, arquivo/linhas, decisão ou nó de flow.
- O contexto enviado é **delimitado e inspecionável**; dados sensíveis e arquivos fora do workspace não devem ser incluídos indiscriminadamente.
- Pode responder de forma curta na paleta ou **expandir/fazer fork** para uma conversa de subagente maior, ainda vinculada à sessão principal.
- O subagente pode produzir um resultado estruturado e um resumo para o agente principal.
- **Não injetar automaticamente toda pergunta exploratória na sessão principal.** O retorno ao agente principal deve seguir uma política explícita (por exemplo, somente após conclusão de tarefa delegada ou comando do usuário).
- Os registros de subagentes devem preservar relação pai-filho e serem reabertos pelo histórico da sessão.

### 6.2 Separação entre perguntar e agir

Distinguir `Ask/Investigate` de `Request change`. Investigações somente de leitura não podem desencadear escrita em repositório, salvo após autorização explícita. Permissões de ferramentas e sandbox do agente continuam obrigatórias.

## 7. Flow

O Flow é um canvas interativo de diagrama, não uma imagem fixa. Cada gráfico deve ser associado ao repositório, checkpoint e prompt utilizado.

### 7.1 UX de geração

No próprio canvas, exibir **controles flutuantes e discretos** com:

- Um **select de preset de prompt**.
- Ações compactas **Add** e **Edit** para criar/editar prompts salvos.
- Campo opcional de **instruções adicionais** específico daquela geração.
- Botão **Generate** para iniciar uma nova execução.

A escolha ou edição de um preset **não deve regenerar** automaticamente o diagrama. A geração começa somente ao acionar **Generate**. Presets são persistentes e reutilizáveis.

### 7.2 Conteúdo do diagrama

- Suportar fluxos de execução, componentes/arquitetura, fluxo de dados e ciclo de requisições de API mediante prompts de geração.
- Nós e arestas apontam, quando possível, para referências verificáveis de código.
- Permitir selecionar nó, abrir arquivo relacionado e chamar BTW com contexto daquele elemento.
- Indicar explicitamente quando um diagrama está desatualizado em relação ao checkpoint atual.
- Priorizar evidência extraída de código (análise estática/estrutura do repositório), usando LLM para organização e explicação.

## 8. Geração automática de artefatos

O Ataraxia deve produzir análises úteis sem exigir que o usuário entre em cada tela para gerá-las.

Fluxo de alto nível:

1. O agente conclui uma unidade relevante de trabalho.
2. O Ataraxia registra checkpoint e diff correspondente.
3. Um orquestrador agenda tarefas especializadas, como detecção de decisões, priorização de revisão e preparação de estruturas para Flow.
4. O resultado é associado à sessão e ao checkpoint, com status `queued/running/ready/failed/stale`.
5. O usuário pode acessar os artefatos quando desejar, sem bloquear o Chat.

Não depender exclusivamente de instruções no system prompt. A execução deve ser coordenada por eventos de runtime e pelo orquestrador; instruções ou MCP auxiliam na troca de contexto e no formato das respostas. Evitar recomputação completa após cada salvamento de arquivo.

## 9. Integração com agentes

A implementação deverá contemplar **ACP (Agent Client Protocol)** como base de integração multiprovedor, com adaptadores para capacidades específicas não padronizadas. A disponibilidade efetiva de cada recurso varia conforme o provedor.

Requisitos mínimos de runtime:

- Iniciar/parar sessões em workspace e worktree corretos.
- Enviar prompts, receber streams/eventos e refletir estado de execução.
- Gerenciar pedidos de permissão e cancelamento.
- Associar atividades do agente a arquivos alterados e checkpoints.
- Iniciar investigações de subagentes com contexto delimitado.
- Vincular comentários e decisões ao histórico próprio do Ataraxia.

O **MCP** deve expor operações de consulta e atualização de artefatos do Ataraxia, com escopo, autorização e auditoria. ACP e MCP exercem papéis distintos: controle de sessões/conversas e exposição de ferramentas/contexto, respectivamente.

## 10. Workspace e persistência

- **Repository:** identificador estável, caminho raiz, remotes e metadados Git.
- **Worktree:** caminho, branch, revisão e relação com repositório.
- **ChatSession:** agente, contexto, worktree, mensagens e timestamps.
- **Checkpoint:** base/head Git, arquivos alterados, evento de origem, status de processamento.
- **Artifact:** tipo (`decision`, `review_priority`, `flow` etc.), checkpoint, versão, conteúdo estruturado e status.
- **DecisionThread:** mensagens, autoria, referências e resolução.
- **BTWTask:** sessão pai, contexto anexado, execução, resumo e política de retorno.
- **FlowPreset:** nome, prompt, versão, preferências e escopo.
- **UserPreference:** tema, navegação, atalhos, preferências de exibição.

SQLite local é uma opção adequada para o MVP. Alterações devem ser transacionais e migrações versionadas. Evitar armazenar credenciais de agentes em texto puro: reutilizar credenciais dos próprios provedores ou armazenamento seguro do sistema.

## 11. Terminal integrado

O terminal utiliza PTY real em implementação desktop e aparece como **painel retrátil inferior**, semelhante ao terminal do VS Code, com altura ajustável e foco de teclado previsível. Deve iniciar no diretório da worktree selecionada, poder ser fechado sem destruir o processo inadvertidamente e apresentar estados de erro/desconexão. O terminal do protótipo é simulado.

## 12. Design system e identidade visual (ATUALIZAÇÃO v1.1)

### 12.1 Decisão tecnológica

**HeroUI v3 é o design system oficial do frontend do Ataraxia.** A escolha busca uma biblioteca com **estética definida, consistente e profissional desde a instalação**, em vez de uma coleção headless que exigiria desenhar todos os controles do zero.

- **Biblioteca React:** [`@heroui/react`](https://www.npmjs.com/package/@heroui/react), linha **v3**.
- **Estilos e tokens:** [`@heroui/styles`](https://github.com/heroui-inc/heroui/tree/v3/packages/styles), Tailwind CSS v4 e variáveis CSS.
- **Documentação:** https://heroui.com/docs/react/getting-started
- **Repositório:** https://github.com/heroui-inc/heroui
- **Licença do HeroUI React v3:** **Apache License 2.0**, open source, gratuita para uso comercial e distribuição conforme a licença. A compra do HeroUI Pro **não é requisito**. As licenças dos pacotes e assets utilizados devem ser conferidas individualmente no lockfile e na distribuição; os estilos podem ter avisos próprios.

### 12.2 Regras de uso

1. Usar componentes estilizados do HeroUI como padrão para select, popover, dialog, drawer, campos, botões, menus, tooltip, feedback e estados de carregamento.
2. **Não** substituir o visual do protótipo por um dashboard HeroUI genérico. A composição, densidade, navegação e hierarquia permanecem ancoradas no Ataraxia.
3. Criar um tema Ataraxia sobre os tokens do HeroUI: neutros predominantes, contraste legível, superfícies discretas e acento restrito a foco, seleção e estados significativos.
4. Evitar cards e bordas decorativas; usar composição tipográfica, alinhamento e espaço negativo como primeiro recurso de hierarquia.
5. Aplicar componentes com comportamento acessível de teclado, foco visível, semântica, estados disabled/loading e suporte a light/dark mode.
6. Respeitar `prefers-reduced-motion`; animações devem ser curtas e não bloquear a interação.
7. Usar somente dependências e assets licenciados para o modelo de distribuição do Ataraxia; não introduzir componentes Pro inadvertidamente.

### 12.3 Componentes especializados, fora do escopo do HeroUI

| Necessidade | Solução prevista | Observação |
|---|---|---|
| Editor e destaque sintático | Monaco Editor | Leitura/edição com viewport de código |
| Diagramas interativos | React Flow | Nós/arestas, navegação, seleção |
| Terminal | xterm.js + PTY nativo | UI do terminal e execução real no backend |
| Paleta BTW | HeroUI Popover/Dialog + lógica própria, ou biblioteca de command palette compatível | Manter estética Spotlight e não criar botão persistente |
| Ícones | Lucide | Traço consistente e baixo ruído visual |

### 12.4 Critérios de aceite visuais

- Ao abrir o aplicativo pela primeira vez, botões, menus, inputs, estados hover/foco e overlays já apresentam um visual coeso **sem uma fase posterior obrigatória de customização**.
- Os quatro espaços mantêm o mesmo tema e regras de layout.
- A interface não inclui header duplicado no Flow, sidebar global fixa ou controles permanentes de comentário/BTW.
- O conteúdo de código continua sendo a prioridade visual no Code; o Flow mantém o canvas como prioridade visual.
- Acessibilidade de teclado e modo escuro são testados como parte do MVP, não tratados apenas como refinamento futuro.

## 13. Arquitetura de alto nível

```text
Ataraxia Desktop (Tauri)
├── React UI (HeroUI v3 theme)
│   ├── Chat
│   ├── Code (Monaco)
│   ├── Decisions
│   ├── Flow (React Flow)
│   ├── BTW palette / subagent conversation
│   └── Retractable terminal (xterm.js)
└── Core / Services (Rust ou processo de serviço local)
    ├── Agent Runtime (ACP + provider adapters)
    ├── Git / Worktree / Checkpoint Manager
    ├── Artifact Orchestrator
    ├── Decision & Review Engine
    ├── Flow Generation Pipeline
    ├── BTW Context & Delegation Manager
    ├── MCP Tools
    └── Persistence (SQLite)
```

A UI nunca deve assumir que um agente está rodando apenas porque há sessão armazenada. Operações mutáveis precisam de verificação de estado, autorização e feedback de falha.

## 14. Requisitos não funcionais

- **Confiabilidade:** status e resultados de tarefas persistem após reiniciar a interface; retentativas não duplicam artefatos indevidamente.
- **Responsividade:** navegação entre espaços e abertura da paleta não devem aguardar trabalho remoto de IA.
- **Segurança:** permissões e sandbox dos agentes devem ser respeitados; execução e escrita não são habilitadas implicitamente por uma pergunta.
- **Privacidade:** envio de código a provedores externos deve respeitar configurações claras por projeto/provedor.
- **Rastreabilidade:** cada decisão, review e flow deve identificar sessão, arquivos, revisão e método de geração quando aplicável.
- **Acessibilidade:** navegação por teclado, foco adequado, contraste e movimento reduzido.
- **Compatibilidade:** adaptações para diferentes agentes precisam de feature detection e degradação explícita.

## 15. Marcos de implementação

1. **Shell desktop e design system:** Tauri, React, HeroUI v3, tema, navegação, repositório/worktree, sessões e persistência inicial.
2. **Agent Chat:** sessão ACP, streaming, ferramentas, permissões e histórico.
3. **Code:** árvore, arquivos alterados, fila por componente, Monaco, revisões Git e alternância de versões.
4. **Decisions:** extração estruturada, tipos, estados, threads e comunicação com agentes.
5. **BTW:** paleta, expansão em subagente, contexto e retorno controlado.
6. **Flow:** canvas, presets de prompts, geração explícita, fontes no código e versionamento.
7. **Orquestração:** checkpoints, geração automática incremental, status e regeneração seletiva.

## 16. Critérios de aceite do MVP

- [ ] É possível escolher repositório/worktree, criar chat e retomar sessões sem perder o vínculo com artefatos.
- [ ] Um agente real pode ser iniciado, receber prompt, transmitir resposta e solicitar permissões.
- [ ] Code mostra arquivo com syntax highlighting; alterna localmente entre Components, Changed files e Project tree.
- [ ] Changed files aparece em coluna única; a fila de componentes permanece visível em seu modo.
- [ ] A revisão por arquivo alterna versão atual e anterior na mesma superfície, sem split diff obrigatório.
- [ ] Decisions exibem o tipo de decisão e uma conversa própria, com aprovação/rejeição independente de review.
- [ ] BTW aparece por atalho em qualquer espaço, recebe contexto correto e pode expandir para investigação persistente.
- [ ] Uma investigação BTW não modifica código por engano nem injeta conversa exploratória automaticamente no chat principal.
- [ ] Flow permite selecionar, adicionar e editar presets; gera apenas após acionamento explícito de Generate e aceita instruções adicionais.
- [ ] O terminal abre e fecha na região inferior, usando o diretório correto da worktree.
- [ ] Artefatos são hierarquicamente vinculados à sessão e ao checkpoint e podem sinalizar desatualização.
- [ ] Os componentes de controle do frontend usam HeroUI v3 gratuito, respeitando a estética minimalista do protótipo e suporte a dark/light mode.

## 17. Referências

- [Protótipo Ataraxia](https://concierge-workspace-poc-20261111.mikael3305.chatgpt.site)
- [HeroUI v3 — documentação](https://heroui.com/en/docs/react/getting-started)
- [HeroUI v3 — repositório](https://github.com/heroui-inc/heroui)
- [HeroUI v3 — React](https://github.com/heroui-inc/heroui/blob/v3/packages/react/README.md)
- [Agent Client Protocol](https://agentclientprotocol.com/)
- [Monaco Editor](https://microsoft.github.io/monaco-editor/)
- [React Flow](https://reactflow.dev/)
- [xterm.js](https://xtermjs.org/)
