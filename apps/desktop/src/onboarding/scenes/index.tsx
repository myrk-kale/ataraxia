import { Player } from "@remotion/player";
import type { ComponentType } from "react";
import { SCENE } from "./kit";
import { BrowserScene, MemoryScene, YoursScene } from "./more";
import { ChatScene, WelcomeScene, WorkflowScene } from "./start";
import { BtwScene, DecisionsScene, FlowScene, ReviewScene } from "./work";

export type SceneId = "welcome" | "workflow" | "chat" | "review" | "decisions" | "flow" | "btw" | "browser" | "memory" | "yours";

const SCENES: Record<SceneId, { component: ComponentType; seconds: number; still: number }> = {
  welcome: { component: WelcomeScene, seconds: 5, still: 110 },
  workflow: { component: WorkflowScene, seconds: 7, still: 170 },
  chat: { component: ChatScene, seconds: 8, still: 190 },
  review: { component: ReviewScene, seconds: 8, still: 200 },
  decisions: { component: DecisionsScene, seconds: 7, still: 165 },
  flow: { component: FlowScene, seconds: 7, still: 175 },
  btw: { component: BtwScene, seconds: 7, still: 175 },
  browser: { component: BrowserScene, seconds: 8, still: 200 },
  memory: { component: MemoryScene, seconds: 8, still: 190 },
  yours: { component: YoursScene, seconds: 8, still: 190 },
};

/**
 * The animation of a slide, drawn with Remotion and played in a loop. It is made of the
 * interface's own colours, so it follows the theme. With reduced motion in the system it is
 * a still frame from the moment everything is on screen.
 */
export default function SlideScene({ scene, still }: { scene: SceneId; still: boolean }) {
  const { component, seconds, still: frame } = SCENES[scene];
  return (
    <Player
      autoPlay={!still}
      component={component}
      compositionHeight={SCENE.height}
      compositionWidth={SCENE.width}
      controls={false}
      durationInFrames={seconds * SCENE.fps}
      fps={SCENE.fps}
      initialFrame={still ? frame : 0}
      loop
      numberOfSharedAudioTags={0}
      style={{ width: "100%", height: "100%" }}
    />
  );
}
