# Auditoria 002: relatório de correção (2026-11-12)

| # | Status | O que mudou |
|---|--------|-------------|
| 1 | feito | o número do selo usa o token de texto sobre a ação (`text-cg-on-primary`): escuro sobre o vermelho claro do tema escuro, branco no claro. Medido: passa de 4,5:1 nos dois temas |
| 2 | feito | os pontos do EdgeNav têm 24,5 px de alvo; o desenho do ponto não mudou |
| 3 | feito | o resumo tem altura mínima de 24,5 px |
| 4 | feito | o app roda dentro de `I18nProvider locale="en-US"`: os rótulos internos da biblioteca saem em inglês ("Dismiss") |
| 5 | feito | placeholder curto, "Ask the agent (it only reads)…", numa linha |
| 6 | feito | a thread fecha antes de abrir "Link a commit" ou "Request a change" e volta quando eles fecham, já mostrando o commit ligado |
| 7 | mantido | decoração fora do 4,5:1 por regra; sem mudança |
| 8 | mantido | botão só para leitor de tela da biblioteca; sem mudança |

Evidência: a mesma medição repetida depois das correções: nenhum texto abaixo de 4,5:1 fora das duas barras decorativas, nenhum alvo visível abaixo de 24 px, 0 problemas no console. Testes de front passam (133) e o percurso no Chrome continua passando.

Ressalvas: tudo foi medido com o mock no Chrome, nada dentro do Tauri nem com provedor real.
