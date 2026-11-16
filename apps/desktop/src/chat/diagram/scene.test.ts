import { describe, expect, it } from "vitest";
import { STYLES, STYLE_NAMES } from "./glyphs";
import { K } from "./palette";
import { Frame, renderEffect } from "./effects";
import { buildScene, cachedScene, type Scene } from "./scene";

function sceneOf(source: string, style: (typeof STYLE_NAMES)[number] = "unicode"): Scene {
  const built = buildScene(source, style);
  if (!built.ok) {
    throw new Error(built.reason);
  }
  return built.scene;
}

describe("buildScene", () => {
  it("draws two boxes and the arrow between them, exactly", () => {
    expect(sceneOf("flowchart LR\nA[Hi] --> B[Yo]").text.split("\n")).toEqual([
      "  ┌──────┐        ┌──────┐",
      "  │  Hi  │───────►│  Yo  │",
      "  └──────┘        └──────┘",
    ]);
  });

  it("draws the same shape in every style, with that style's pieces", () => {
    for (const name of STYLE_NAMES) {
      const text = sceneOf("flowchart LR\nA[Hi] --> B[Yo]", name).text;
      expect(text).toContain(STYLES[name].tl);
      expect(text).toContain(STYLES[name].br);
      expect(text).toContain("Hi");
    }
    const ascii = sceneOf("flowchart LR\nA[Hi] --> B[Yo]", "ascii").text;
    expect(ascii).toContain(">");
    expect([...ascii].every((c) => c.charCodeAt(0) < 128)).toBe(true);
  });

  it("rounds the corners of a round node, and points the sides of a decision", () => {
    const round = sceneOf("flowchart LR\nA(Hi)", "unicode").text;
    expect(round).toContain("╭");
    expect(round).toContain("╯");
    const decision = sceneOf("flowchart LR\nQ{Ok?}", "unicode").text;
    expect(decision).toContain("<");
    expect(decision).toContain(">");
  });

  it("points the arrowhead the way the line arrives, and leaves an open link without one", () => {
    expect(sceneOf("flowchart LR\nA --> B").text).toContain("►");
    expect(sceneOf("flowchart RL\nA --> B").text).toContain("◄");
    expect(sceneOf("flowchart TD\nA --> B").text).toContain("▼");
    expect(sceneOf("flowchart BT\nA --> B").text).toContain("▲");
    const open = sceneOf("flowchart LR\nA --- B").text;
    expect(open).not.toMatch(/[►◄▼▲]/);
  });

  it("writes a link label in the line", () => {
    const text = sceneOf("flowchart LR\nA -->|accepted| B").text;
    expect(text).toMatch(/─+ accepted ─+►/);
  });

  it("joins lines that meet with a corner or a tee", () => {
    const text = sceneOf("flowchart LR\nR --> A\nR --> B\nR --> C", "unicode").text;
    expect(text).toMatch(/[┬┤├┴┼┘└┐┌]/);
  });

  it("gives every drawn cell a colour class and every empty cell none", () => {
    const scene = sceneOf("flowchart LR\nA[One] --> B[Two]");
    for (let i = 0; i < scene.baseGlyph.length; i += 1) {
      expect(scene.baseGlyph[i] === 0).toBe(scene.baseCls[i] === K.none);
    }
  });

  it("lists each node's cells: the box, the label, and all of it", () => {
    const scene = sceneOf("flowchart LR\nA[One]");
    const node = scene.nodes[0]!;
    expect(node.labelCells).toHaveLength(3);
    expect(node.border).toHaveLength(2 * node.w + 2 * (node.h - 2));
    expect(new Set(node.border).size).toBe(node.border.length);
    expect(node.all).toHaveLength(node.border.length + node.labelCells.length);
    for (const cell of node.all) {
      expect(scene.baseGlyph[cell]).not.toBe(0);
    }
  });

  it("walks each line from its source to its target, ending on the arrowhead", () => {
    const scene = sceneOf("flowchart LR\nA --> B");
    const edge = scene.edges[0]!;
    expect(edge.cells.length).toBeGreaterThan(2);
    expect(scene.baseCls[edge.cells.at(-1)!]).toBe(K.arrow);
    expect(scene.baseCls[edge.cells[0]!]).toBe(K.edge);
  });

  it("orders the nodes the way the flow goes", () => {
    const scene = sceneOf("flowchart LR\nA --> B --> C\nA --> D");
    expect(scene.order.map((n) => n.id).slice(0, 1)).toEqual(["A"]);
    expect(scene.order.at(-1)!.rank).toBe(2);
  });

  it("describes the diagram in words", () => {
    const scene = sceneOf("flowchart LR\nC[Client] --> G[Gateway]\nG -->|ok| Q[Queue]\nZ[Lonely]");
    expect(scene.alt).toBe("Flowchart, left to right. Client to Gateway; Gateway to Queue (ok). Not linked: Lonely.");
  });

  it("refuses what it cannot draw, saying why", () => {
    for (const source of ["sequenceDiagram\nA->>B: hi", "flowchart LR\nsubgraph x\nA-->B", "flowchart LR\nA[日本語] --> B"]) {
      const built = buildScene(source, "unicode");
      expect(built.ok).toBe(false);
    }
  });
});

describe("cachedScene", () => {
  it("lays a diagram out once and hands back the same scene", () => {
    const source = "flowchart LR\nA --> B";
    expect(cachedScene(source, "rounded")).toBe(cachedScene(source, "rounded"));
    expect(cachedScene(source, "rounded")).not.toBe(cachedScene(source, "ascii"));
  });

  it("keeps a bounded number", () => {
    const first = cachedScene("flowchart LR\nA0 --> B", "rounded");
    for (let i = 1; i < 40; i += 1) {
      cachedScene(`flowchart LR\nA${i} --> B`, "rounded");
    }
    expect(cachedScene("flowchart LR\nA0 --> B", "rounded")).not.toBe(first);
  });
});

describe("charts that used to go to the library", () => {
  it("draws the scheduler chart as text, with every label whole", () => {
    const source = SCHEDULER;
    const scene = sceneOf(source);
    const flat = scene.text.replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ");
    for (const label of ["ApiService.add_schedule", "schedule_cancel"]) {
      expect(scene.text).toContain(label.slice(0, 12));
    }
    expect(flat).toContain("Faixa Scheduled");
    expect(flat).toContain("para cancelar");
    expect(scene.nodes.length).toBe(28);
    expect(scene.text).not.toContain("…");
  });

  it("still draws a short chain the way it always did, one row of text per box", () => {
    const scene = sceneOf(
      'flowchart TD\nU["Contexto, pergunta e opções"] --> J["AnyJev prepara as avaliações"]\nJ --> P["Pythia calcula os escores das opções"]',
    );
    expect(scene.nodes.every((node) => node.h === 3)).toBe(true);
  });
});

const SCHEDULER = `flowchart TD
    AG["Agente do chat: Claude, Codex ou OpenCode"] -->|curl POST /v1/schedules| API["ApiService.add_schedule"]
    CL["Claude Code: CLAUDE_CODE_DISABLE_CRON=1"] -.->|cron nativo desligado, só o do app vale| AG

    API --> VA["Valida prompt e in_minutes ou at, mais every_minutes opcional"]
    VA --> SA["Engine.schedule_add"]
    SA --> VE["Valida: é um chat, de 1 min a 7 dias, no máximo 20 por chat"]
    VE --> DB["Grava em preferências: schedules:id-do-chat e o índice schedules:chats"]
    DB -->|InsightEvent Schedules| UH["useSchedules"]
    UH --> UI1["Faixa Scheduled: texto, próximo horário e X para cancelar"]
    UI1 -->|schedule_cancel| CA["Engine.schedule_cancel"]
    CA --> DB
    DB -->|201 com id e next_run| AG

    CK["Relógio start_scheduler: confere a cada 5 s"] --> TK["schedules_tick: percorre os chats do índice"]
    DB -.->|chats com agendamentos| TK
    TK --> CH{"O chat ainda existe?"}
    CH -->|não| DEL["Apaga os agendamentos do chat"]
    CH -->|sim| LV{"Agente rodando? Ready, Working ou WaitingPermission"}
    LV -->|não| WT["Espera: dispara uma vez quando o agente voltar, sem repor as perdidas"]
    LV -->|sim| DU{"Algum next_run já venceu?"}
    DU -->|não| CK
    DU -->|sim| EX{"Recorrente e expirada, passou de 7 dias?"}
    EX -->|sim| DROP["Descarta sem rodar"]
    EX -->|não| UP["Avança o agendamento: recorrente vira agora + intervalo, avulso é removido"]
    UP --> SV["Salva e emite Schedules, a faixa se atualiza"]
    SV --> QH{"Mensagem igual já está na fila?"}
    QH -->|sim| SK["Pula, para não empilhar"]
    QH -->|não| EQ["enqueue: texto Scheduled task id, mais o prompt"]

    EQ --> FQ["Fila de mensagens do chat"]
    FQ -->|agente livre, uma por vez| DP["dispatch: runtime.prompt"]
    FQ -.->|turno parado: fila pausada, herda a pausa| FQ
    DP --> AT["Agente executa o turno e age, por exemplo conferir o release"]
    AT --> TR["Transcript: linha Scheduled, não um balão do usuário"]
    AT -->|ainda não terminou| AG
`;

describe("subgraphs", () => {
  const SOURCE = "flowchart TD\nX --> A\nsubgraph s[Group]\nA --> B\nend";

  it("draws a titled frame round what is inside it", () => {
    const scene = sceneOf(SOURCE);
    expect(scene.frames.map((f) => f.title)).toEqual(["Group"]);
    expect(scene.text).toContain("╭─ Group");
    expect(scene.text).toContain("╰");
    expect(scene.text).toContain("╯");
    // The title is in the frame's top edge, not in a box of its own.
    expect(scene.nodes.map((n) => n.id)).toEqual(["X", "A", "B"]);
  });

  it("draws it with plain characters too", () => {
    expect(sceneOf(SOURCE, "ascii").text).toContain("Group");
  });

  it("lets a link run over the frame where it crosses, and leaves that cell to the link", () => {
    const scene = sceneOf(SOURCE);
    const link = new Set(scene.edges.flatMap((e) => e.cells));
    expect(scene.frameCells.length).toBeGreaterThan(0);
    expect(scene.frameCells.every((cell) => !link.has(cell))).toBe(true);
    const crossing = scene.edges.flatMap((e) => e.cells).filter((cell) => {
      const x = cell % scene.width;
      const y = Math.floor(cell / scene.width);
      const f = scene.frames[0]!;
      return y === f.y && x > f.x && x < f.x + f.w - 1;
    });
    expect(crossing.length).toBeGreaterThan(0);
  });

  it("keeps the frame on screen while the animations draw what is inside it", () => {
    const scene = sceneOf(SOURCE);
    for (const effect of ["reveal", "typing"] as const) {
      const frame = new Frame(scene.width * scene.height);
      renderEffect(effect, scene, 0.001, frame);
      for (const cell of scene.frameCells) {
        expect(frame.glyph[cell], `${effect} hides a cell of the frame`).toBe(scene.baseGlyph[cell]);
      }
    }
  });

  it("tells a screen reader which nodes are in which group", () => {
    expect(sceneOf(SOURCE).alt).toContain("Group Group: A, B.");
    expect(sceneOf("flowchart TD\nsubgraph o[Outer]\nsubgraph i[Inner]\nA\nend\nend").alt).toContain(
      "Group Inner (inside Outer): A.",
    );
  });

  it("draws the scheduler chart written with subgraphs as text", () => {
    const scene = sceneOf(SUBGRAPHS);
    expect(scene.frames.map((f) => f.title)).toEqual(["Agente do chat", "API local", "Relógio, a cada 5 s", "Fila de mensagens"]);
    expect(scene.text).toContain("schedule_add");
  });

  it("still refuses a group title it cannot draw in one cell per character", () => {
    expect(buildScene("flowchart TD\nsubgraph s[日本語]\nA\nend", "unicode").ok).toBe(false);
  });
});

const SUBGRAPHS = `flowchart TD
    subgraph Agente["Agente do chat"]
        AG["Claude, Codex ou OpenCode"]
    end
    subgraph API["API local"]
        direction LR
        P["POST /v1/schedules"] --> V["Valida os campos"] --> S["schedule_add"] --> DB["Grava em preferências"]
    end
    subgraph Relogio["Relógio, a cada 5 s"]
        TK["schedules_tick"] --> LV{"Agente rodando?"}
        LV -->|sim| DU{"Venceu?"}
        LV -->|não| WT["Espera"]
        DU -->|sim| EQ["enqueue"]
    end
    subgraph Fila["Fila de mensagens"]
        FQ["Fila do chat"] --> DP["dispatch"]
    end
    AG -->|curl| P
    DB -.-> TK
    EQ --> FQ
    DP --> AG
`;
