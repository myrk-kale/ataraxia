import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  /** What broke, in the user's words: "Code", "the app". */
  label: string;
  children: ReactNode;
};

type State = { error: Error | null };

/**
 * One broken screen must not take the whole app with it. The boundary shows what failed and
 * lets the person try again; the other spaces keep working.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Ataraxia: ${this.props.label} failed to render`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }
    return (
      <section
        className="mx-auto mt-[16vh] flex max-w-[560px] flex-col items-center gap-3 px-8.5 text-center"
        role="alert"
      >
        <h1 className="text-heading font-semibold text-cg-ink">{`${this.props.label} stopped working`}</h1>
        <p className="text-ui leading-6 text-cg-muted-strong">{this.state.error.message}</p>
        <button
          className="rounded-cg-md border border-cg-line-strong bg-cg-panel px-3.5 py-2.5 text-ui font-medium text-cg-ink hover:bg-cg-tint"
          type="button"
          onClick={() => this.setState({ error: null })}
        >
          Try again
        </button>
      </section>
    );
  }
}
