/** Prefix completion based on a small common vocabulary and words typed in this chat. */
const COMMON = `adicionar adicionar alterar alteração analisar aplicativo arquivo arquivos agora ainda agente agentes ajustar ajuste apenas após aprovar assim atendimento atualizar botão buscar cada campo caminho chat código começar comentário como comando comparar completar componente configuração confirmar considerar contexto continuar corrigir criar quando decisão decisões depois descrição desenvolver deve documento durante endereço entanto enviar erros estado exemplo executar exibir existente fazer fechar finalizar fluxo formulário função funcionamento gerar histórico idioma imagem implementar importante informação informações interface incluir lista mensagem mensagens mostrar mudança necessário necessidade nenhuma novo número opção palavra palavras para parte pessoa poder possível precisa primeiro processo próximo quantidade quando quero resposta resultado revisar seção selecionar sempre sistema somente tarefa tela texto todas todos usuário valor verificar visualizar workspace
about action add agent after all also and any application are available back before button change chat check code command component context copy create current data decision delete details display each error example file files first fix for from function have help implement include information list make message model more new next only open option other output please previous project provide read remove replace result review save section select session should show state system task test text that the this update use user using value view want when where with workspace would`.split(/\s+/);

const histories = new Map<string, Map<string, number>>();

export function rememberWords(sessionId: string, text: string): void {
  const words = histories.get(sessionId) ?? new Map<string, number>();
  for (const match of text.matchAll(/[\p{L}\p{N}_-]{2,}/gu)) {
    const word = match[0];
    if (word.length <= 80) words.set(word, Math.min(1000, (words.get(word) ?? 0) + 1));
  }
  histories.set(sessionId, words);
}

export function completeWord(sessionId: string, text: string): string | null {
  const match = /(?:^|[\s([{])([\p{L}][\p{L}\p{N}_-]{1,})$/u.exec(text);
  if (!match) return null;
  const prefix = match[1].toLocaleLowerCase();
  const learned = histories.get(sessionId);
  let best: { word: string; score: number } | null = null;
  let index = 0;
  for (const word of new Set([...COMMON, ...(learned?.keys() ?? [])])) {
    index += 1;
    if (!word.toLocaleLowerCase().startsWith(prefix) || word.length <= match[1].length) continue;
    const score = (learned?.get(word) ?? 0) * 1000 - index;
    if (!best || score > best.score) best = { word, score };
  }
  return best ? best.word.slice(match[1].length) : null;
}
