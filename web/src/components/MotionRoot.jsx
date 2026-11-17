import { LazyMotion, MotionConfig } from 'motion/react';

// Components use `m.*` (not `motion.*`): the animation features load after the first paint, in their own chunk. If that chunk
// cannot load (a tab left open across a deploy), nothing animates and everything is still shown: no component hides content
// behind a motion-only initial state.
const loadFeatures = () => import('../lib/motion-features.js').then((mod) => mod.default).catch(() => ({}));

/** Gives every `m.*` element below it motion that follows the person's reduced-motion setting. */
export function MotionRoot({ children }) {
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={loadFeatures} strict>{children}</LazyMotion>
    </MotionConfig>
  );
}
