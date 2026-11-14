/**
 * Shown while the agent works and nothing has come back yet. It is a status, so it has a name
 * to read out; the motion is decoration and stops for people who ask for less of it.
 */
export function Loader({ label }: { label: string }) {
  return (
    <span aria-label={label} className="cg-loader -mt-5 self-start text-cg-muted" role="status">
      <span />
      <span />
      <span />
    </span>
  );
}
