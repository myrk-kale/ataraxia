import { type KeyboardEvent, useId, useLayoutEffect, useMemo, useState } from "react";
import {
  type ComposerResource,
  type MentionChat,
  type MentionPath,
  agentListComposerResources,
  sessionChats,
  sessionPaths,
} from "../lib/agent";
import type { SessionId } from "../lib/workspace";
import {
  type PickerItem,
  applyChoice,
  chatItems,
  commandItems,
  findTrigger,
  mentionItems,
} from "./pickerChoices";
import { pickerOptionId } from "./ComposerPicker";

/**
 * The `/` and `@` pickers of the message field. The field keeps the focus and the caret; this
 * works out what is being typed, what the session offers, and what a choice does to the text.
 */
export function useComposerPicker({
  sessionId,
  draft,
  onDraft,
  field,
  commands: commandsOn,
}: {
  sessionId: SessionId;
  draft: string;
  onDraft: (text: string) => void;
  field: { current: HTMLTextAreaElement | null };
  /** `/` offers session resources in the main conversation. */
  commands: boolean;
}) {
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [resources, setResources] = useState<ComposerResource[]>([]);
  const [paths, setPaths] = useState<MentionPath[]>([]);
  const [chats, setChats] = useState<MentionChat[]>([]);
  const [cursor, setCursor] = useState({ for: "", index: 0 });
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [restore, setRestore] = useState<number | null>(null);

  const found = findTrigger(draft, Math.min(caret, draft.length), commandsOn);
  const trigger = found && dismissed !== `${found.kind}:${found.start}` ? found : null;
  const query = trigger ? `${trigger.kind}:${trigger.query}` : "";

  const items: PickerItem[] = useMemo(() => {
    if (!trigger) {
      return [];
    }
    return trigger.kind === "command"
      ? commandItems(resources, trigger.query)
      : [
          ...chatItems(chats, trigger.query),
          ...(/^chat:/i.test(trigger.query) ? [] : mentionItems(paths, trigger.query)),
        ];
    // `trigger` is rebuilt each render; what it holds is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger?.kind, trigger?.query, resources, paths, chats]);

  const active = cursor.for === query ? Math.min(cursor.index, Math.max(items.length - 1, 0)) : 0;
  const open = trigger !== null && items.length > 0;

  // Put the caret where a choice left it, once the new text is in the field.
  useLayoutEffect(() => {
    if (restore !== null) {
      field.current?.setSelectionRange(restore, restore);
      setRestore(null);
    }
  }, [restore, field]);

  function opened(next: ReturnType<typeof findTrigger>) {
    // What the choices are is read again each time the picker opens: commands come and go
    // (a plugin loads), and files change as the agent works.
    if (!next || next.kind === trigger?.kind) {
      return;
    }
    if (next.kind === "command") {
      void agentListComposerResources(sessionId)
        .then(setResources)
        .catch(() => setResources([]));
    } else {
      void sessionPaths(sessionId)
        .then(setPaths)
        .catch(() => setPaths([]));
      void sessionChats(sessionId)
        .then(setChats)
        .catch(() => setChats([]));
    }
  }

  function track(element: HTMLTextAreaElement) {
    const next = findTrigger(element.value, element.selectionStart, commandsOn);
    opened(next);
    setCaret(element.selectionStart);
  }

  function pick(item: PickerItem) {
    if (!trigger) {
      return;
    }
    const done = applyChoice(draft, trigger, item.insert);
    onDraft(done.text);
    setCaret(done.caret);
    setRestore(done.caret);
  }

  /** Returns true when the key was for the picker, so the field leaves it alone. */
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open || !trigger || event.nativeEvent.isComposing) {
      return false;
    }
    const step = (by: number) =>
      setCursor({ for: query, index: (active + by + items.length) % items.length });
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        step(1);
        return true;
      case "ArrowUp":
        event.preventDefault();
        step(-1);
        return true;
      case "Enter":
      case "Tab":
        if (event.shiftKey) {
          return false;
        }
        event.preventDefault();
        pick(items[active]);
        return true;
      case "Escape":
        // Closes the list, not whatever the Esc key would otherwise stop.
        event.preventDefault();
        event.stopPropagation();
        setDismissed(`${trigger.kind}:${trigger.start}`);
        return true;
      default:
        return false;
    }
  }

  return {
    open,
    listId,
    items,
    active,
    activeId: open ? pickerOptionId(listId, items[active]) : undefined,
    label: trigger?.kind === "command" ? "Commands, skills, and MCP servers" : "Files and conversations",
    pick,
    hover: (index: number) => setCursor({ for: query, index }),
    onKeyDown,
    onChange: (element: HTMLTextAreaElement) => {
      onDraft(element.value);
      track(element);
    },
    onSelect: track,
  };
}
