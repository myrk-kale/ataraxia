import { SPACES, type SpaceId } from "./spaces";

function Dot({
  label,
  active,
  small,
  onSelect,
}: {
  label: string;
  active: boolean;
  small: boolean;
  onSelect: () => void;
}) {
  const size = small ? "h-[5px] w-[5px]" : "h-[7px] w-[7px]";
  const idle = small ? "bg-cg-line-strong" : "bg-cg-muted/60";
  return (
    <button
      aria-current={active ? "page" : undefined}
      aria-label={label}
      className="group relative flex h-6 w-6 items-center justify-center rounded-full"
      type="button"
      onClick={onSelect}
    >
      <span
        className={`${size} rounded-full transition-all duration-200 group-hover:scale-125 ${
          active
            ? "bg-cg-accent shadow-[0_0_0_5px_var(--cg-accent-bg)]"
            : `${idle} group-hover:bg-cg-muted-strong`
        }`}
      />
      <span className="pointer-events-none absolute top-1/2 right-[34px] translate-x-[3px] -translate-y-1/2 rounded-[7px] bg-cg-tip-bg px-[11px] py-2 text-small font-medium whitespace-nowrap text-cg-tip-fg opacity-0 shadow-lg transition-all group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100">
        {label}
      </span>
    </button>
  );
}

export function EdgeNav({
  space,
  onSelect,
}: {
  space: SpaceId;
  onSelect: (space: SpaceId) => void;
}) {
  const workspaces = SPACES.filter((item) => item.group === "workspace");
  const artifacts = SPACES.filter((item) => item.group === "artifact");
  return (
    <nav
      aria-label="Spaces"
      className="fixed top-1/2 right-3 z-40 flex w-[25px] -translate-y-1/2 flex-col items-center gap-3 rounded-[20px] bg-cg-float py-3.5 shadow-[0_3px_15px_rgba(38,41,37,0.04)] backdrop-blur"
    >
      <div className="flex w-full flex-col items-center gap-2">
        {workspaces.map((item) => (
          <Dot
            key={item.id}
            active={item.id === space}
            label={item.label}
            small={false}
            onSelect={() => onSelect(item.id)}
          />
        ))}
      </div>
      <div className="relative flex w-full flex-col items-center gap-2 pt-3.5 before:absolute before:top-px before:h-[9px] before:w-px before:bg-cg-line-strong before:content-['']">
        {artifacts.map((item) => (
          <Dot
            key={item.id}
            active={item.id === space}
            label={item.label}
            small
            onSelect={() => onSelect(item.id)}
          />
        ))}
      </div>
    </nav>
  );
}
