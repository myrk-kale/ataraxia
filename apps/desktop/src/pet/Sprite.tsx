import "./pet.css";
import type { AccessoryId, SpeciesId } from "./config";
import type { PetState } from "./activity";

const LINE = "#26233a";

/** Where each species' face sits and where its head ends, so eyes and accessories can be put on any of them. */
const FACE: Record<SpeciesId, { eyeY: number; topY: number }> = {
  blob: { eyeY: 56, topY: 14 },
  cat: { eyeY: 58, topY: 30 },
  bunny: { eyeY: 62, topY: 34 },
  robot: { eyeY: 52, topY: 30 },
  ghost: { eyeY: 52, topY: 14 },
};

function Body({ species, color }: { species: SpeciesId; color: string }) {
  const paint = { fill: color, stroke: LINE, strokeWidth: 3, strokeLinejoin: "round" as const };
  const belly = <ellipse cx="50" cy="70" rx="18" ry="11" fill="#fff" opacity="0.28" />;
  switch (species) {
    case "blob":
      return (
        <>
          <path d="M50 12 C70 12 86 32 86 58 C86 80 70 90 50 90 C30 90 14 80 14 58 C14 32 30 12 50 12Z" {...paint} />
          {belly}
        </>
      );
    case "cat":
      return (
        <>
          <polygon points="20,42 26,12 46,30" {...paint} />
          <polygon points="80,42 74,12 54,30" {...paint} />
          <polygon points="27,34 29,21 38,29" fill="#fff" opacity="0.4" />
          <polygon points="73,34 71,21 62,29" fill="#fff" opacity="0.4" />
          <ellipse cx="50" cy="62" rx="35" ry="29" {...paint} />
          {belly}
          <path d="M16 62 L4 58 M16 68 L4 70 M84 62 L96 58 M84 68 L96 70" stroke={LINE} strokeWidth="2" strokeLinecap="round" />
        </>
      );
    case "bunny":
      return (
        <>
          <ellipse cx="36" cy="22" rx="9" ry="21" {...paint} />
          <ellipse cx="64" cy="22" rx="9" ry="21" {...paint} />
          <ellipse cx="36" cy="24" rx="4" ry="14" fill="#fff" opacity="0.4" />
          <ellipse cx="64" cy="24" rx="4" ry="14" fill="#fff" opacity="0.4" />
          <ellipse cx="50" cy="64" rx="31" ry="27" {...paint} />
          {belly}
        </>
      );
    case "robot":
      return (
        <>
          <line x1="50" y1="30" x2="50" y2="14" stroke={LINE} strokeWidth="3" strokeLinecap="round" />
          <circle cx="50" cy="12" r="5" fill="#e0695f" stroke={LINE} strokeWidth="3" />
          <circle cx="14" cy="56" r="5" {...paint} />
          <circle cx="86" cy="56" r="5" {...paint} />
          <rect x="18" y="30" width="64" height="56" rx="15" {...paint} />
          <rect x="26" y="38" width="48" height="30" rx="9" fill="#fff" opacity="0.3" />
        </>
      );
    case "ghost":
      return (
        <>
          <path d="M18 90 V50 C18 28 32 12 50 12 C68 12 82 28 82 50 V90 L71 81 L60 90 L50 81 L40 90 L29 81 Z" {...paint} />
          {belly}
        </>
      );
  }
}

function Face({ state, eyeY }: { state: PetState; eyeY: number }) {
  const left = 38;
  const right = 62;
  const mouthY = eyeY + 12;
  const stroke = { stroke: LINE, strokeWidth: 3, strokeLinecap: "round" as const, fill: "none" };
  switch (state) {
    case "ready":
      return (
        <>
          <path d={`M${left - 5} ${eyeY + 1} Q${left} ${eyeY - 6} ${left + 5} ${eyeY + 1}`} {...stroke} />
          <path d={`M${right - 5} ${eyeY + 1} Q${right} ${eyeY - 6} ${right + 5} ${eyeY + 1}`} {...stroke} />
          <path d={`M${left + 4} ${mouthY - 1} Q50 ${mouthY + 10} ${right - 4} ${mouthY - 1}`} {...stroke} />
        </>
      );
    case "blocked":
      return (
        <>
          <path d={`M${left - 4} ${eyeY - 4} l8 8 m0 -8 l-8 8`} {...stroke} />
          <path d={`M${right - 4} ${eyeY - 4} l8 8 m0 -8 l-8 8`} {...stroke} />
          <path d={`M${left + 6} ${mouthY + 4} Q50 ${mouthY - 4} ${right - 6} ${mouthY + 4}`} {...stroke} />
        </>
      );
    case "needs-input":
      return (
        <>
          <circle cx={left} cy={eyeY} r="6" fill="#fff" stroke={LINE} strokeWidth="2.5" />
          <circle cx={right} cy={eyeY} r="6" fill="#fff" stroke={LINE} strokeWidth="2.5" />
          <circle cx={left} cy={eyeY + 1} r="2.6" fill={LINE} />
          <circle cx={right} cy={eyeY + 1} r="2.6" fill={LINE} />
          <ellipse cx="50" cy={mouthY + 2} rx="3.6" ry="4.4" fill={LINE} />
        </>
      );
    case "running":
      return (
        <>
          <ellipse cx={left} cy={eyeY} rx="3.6" ry="2.6" fill={LINE} />
          <ellipse cx={right} cy={eyeY} rx="3.6" ry="2.6" fill={LINE} />
          <path d={`M${left - 6} ${eyeY - 8} l9 2 M${right + 6} ${eyeY - 8} l-9 2`} {...stroke} strokeWidth={2.4} />
          <path d={`M${left + 7} ${mouthY + 1} h${right - left - 14}`} {...stroke} />
        </>
      );
    default:
      return (
        <>
          <g className="pet-blink">
            <ellipse cx={left} cy={eyeY} rx="3.4" ry="4.2" fill={LINE} />
            <ellipse cx={right} cy={eyeY} rx="3.4" ry="4.2" fill={LINE} />
          </g>
          <path d={`M${left + 6} ${mouthY} Q50 ${mouthY + 6} ${right - 6} ${mouthY}`} {...stroke} strokeWidth={2.6} />
        </>
      );
  }
}

function Accessory({ id, species, eyeY }: { id: AccessoryId; species: SpeciesId; eyeY: number }) {
  const top = FACE[species].topY;
  const paint = { stroke: LINE, strokeWidth: 3, strokeLinejoin: "round" as const };
  switch (id) {
    case "cap":
      return (
        <g transform={`translate(0 ${top - 6})`}>
          <path d="M24 24 Q50 -4 76 24 Z" fill="#5b8def" {...paint} />
          <path d="M58 23 Q84 20 86 28 L58 28 Z" fill="#3c6bd0" {...paint} />
        </g>
      );
    case "glasses":
      return (
        <g fill="rgba(255,255,255,0.35)" stroke={LINE} strokeWidth="2.6">
          <circle cx="38" cy={eyeY} r="9" />
          <circle cx="62" cy={eyeY} r="9" />
          <line x1="47" y1={eyeY} x2="53" y2={eyeY} />
        </g>
      );
    case "bow":
      return (
        <g transform={`translate(72 ${top + 10})`}>
          <polygon points="0,0 -14,-9 -14,9" fill="#e0695f" {...paint} />
          <polygon points="0,0 14,-9 14,9" fill="#e0695f" {...paint} />
          <circle r="4" fill="#c4473d" {...paint} />
        </g>
      );
    case "crown":
      return (
        <g transform={`translate(0 ${top - 14})`}>
          <path d="M30 22 L35 4 L43 14 L50 2 L57 14 L65 4 L70 22 Z" fill="#f2c14e" {...paint} />
        </g>
      );
    default:
      return null;
  }
}

function Badge({ state }: { state: PetState }) {
  if (state === "idle") return null;
  const paint = { stroke: LINE, strokeWidth: 2.5 };
  return (
    <g>
      {state === "running" ? (
        <g>
          <rect x="62" y="4" width="34" height="18" rx="9" fill="#fff" {...paint} />
          <g fill="#665698">
            <circle className="pet-dot" cx="72" cy="13" r="2.6" />
            <circle className="pet-dot" cx="79" cy="13" r="2.6" />
            <circle className="pet-dot" cx="86" cy="13" r="2.6" />
          </g>
        </g>
      ) : (
        <>
          <circle cx="86" cy="14" r="11" fill={state === "needs-input" ? "#e2a03f" : state === "ready" ? "#3fa58a" : "#e0695f"} {...paint} />
          {state === "needs-input" ? <text x="86" y="19.5" fontSize="15" fontWeight="700" textAnchor="middle" fill="#fff">!</text> : null}
          {state === "ready" ? <path d="M80 14.5 l4 4 l7 -8" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" /> : null}
          {state === "blocked" ? <path d="M81 9 l10 10 m0 -10 l-10 10" stroke="#fff" strokeWidth="3" strokeLinecap="round" fill="none" /> : null}
        </>
      )}
    </g>
  );
}

const LABEL: Record<PetState, string> = {
  idle: "resting",
  running: "working",
  "needs-input": "needs you",
  ready: "done",
  blocked: "stopped with an error",
};

/** The companion, drawn: a species with a colour and an accessory, or the person's own picture, in the way its state moves it. */
export function Sprite({
  species,
  color,
  accessory,
  state,
  image,
  name,
  size,
}: {
  species: SpeciesId;
  color: string;
  accessory: AccessoryId;
  state: PetState;
  image: string | null;
  name: string;
  size: number;
}) {
  const face = FACE[species];
  return (
    <div aria-label={`${name}, ${LABEL[state]}`} className="pet relative" data-state={state} role="img" style={{ width: size, height: size }}>
      {image ? (
        <>
          <img alt="" className="pet-body h-full w-full object-contain" draggable={false} src={image} />
          <svg aria-hidden="true" className="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 100 100">
            <Badge state={state} />
          </svg>
        </>
      ) : (
        <svg aria-hidden="true" className="h-full w-full overflow-visible" viewBox="0 0 100 100">
          <ellipse cx="50" cy="93" rx="26" ry="4" fill="#000" opacity="0.14" />
          <g className="pet-body">
            <Body color={color} species={species} />
            <Face eyeY={face.eyeY} state={state} />
            <Accessory eyeY={face.eyeY} id={accessory} species={species} />
          </g>
          <Badge state={state} />
        </svg>
      )}
    </div>
  );
}
