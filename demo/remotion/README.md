# Jevyr Remotion demos

These are optional visual explainers for Jevyr. They use React and Remotion to show
the Case lifecycle, the Chamber's Couch view, competing candidates, controlled worlds,
and the difference between a model claim and a measured result.

It is intentionally self-contained and does not connect to a live Jevyr daemon.
The visuals are explanatory, not evidence of a real Case.

## Run it

From this directory:

~~~bash
pnpm install
pnpm studio
~~~

Render a short preview:

~~~bash
pnpm render:preview
~~~

Render the one-minute social launch cut:

~~~bash
pnpm render:short
~~~

Render the plain-language “What if?” cut:

~~~bash
pnpm render:what-if
~~~

Render the complete five-minute video:

~~~bash
pnpm render
~~~

The long cut is deliberately slower and more explanatory. The first short cut is
an action-led launch film: question, seal, divergence, execution, evidence, close.
The second short cut keeps one simple “What if?” question running through the whole
film for viewers who prefer plain language. Both short cuts are silent so you can
add a soundtrack or voiceover that fits the post.
Both compositions are Full HD (1920×1080) at 30 fps. The render scripts use a
high-quality H.264 CRF 16 encode; use Remotion's --scale option when you need a
larger master.

The repository also keeps the two one-minute social exports in `public/` so they
can be watched directly from GitHub: `jevyr-launch-short.mp4` and
`jevyr-what-if-short.mp4`.

Remotion creates videos with React and renders real video frames from code. See
the [official Remotion documentation](https://www.remotion.dev/docs) for the
full toolchain and licensing terms.
