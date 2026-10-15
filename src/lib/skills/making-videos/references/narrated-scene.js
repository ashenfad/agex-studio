/*
 * One narrated scene in a module of its own: the unit to build when a
 * video is split across files, or across delegates. Copy it to
 * app/scenes/<id>.js and change every "intro" to the scene's id. The
 * page places it, at the end of its <body>:
 *
 *   <script type="module">
 *     import intro from './scenes/intro.js';
 *     intro({ start: 9.5 });
 *   </script>
 *
 * TIMING. `start` is where the scene begins on the video's clock, in
 * seconds. CSS animations inside the scene count from the scene's own
 * start, as in the page. Clips (the narration below) and Anime.js steps
 * take the video's time, so they add `start`.
 *
 * LENGTH. The scene lasts as long as its narration plus room around it:
 * 0.4s before the voice, about a second after. media.speech returned the
 * narration's `seconds` (3.4 here), so the scene is 0.4 + 3.4 + 1.0 =
 * 4.8s. The page's root data-duration has to reach the end of its last
 * scene: add this one's length there.
 *
 * PATHS. media.speech wrote app/audio/intro.ogg: its paths count from
 * /workspace. The page's build doesn't see a path a script sets, so the
 * scene takes the file's URL from window.appAssets, by its path under
 * app/: 'audio/intro.ogg'.
 *
 * STYLE. Every scene lands in the same page, so this one's rules are
 * scoped to its id, and its keyframes carry the id in their names. The
 * wrappers (.scene, .scene-in, .scene-out), the fonts and the colours
 * are the page's, shared by every scene.
 */

const ID = 'intro';
/** The narration's length: what media.speech returned. */
const VOICE = 3.4;
/** 0.4s before the voice, about a second after. */
export const DURATION = 0.4 + VOICE + 1.0;

export default function intro({ start }) {
  const style = document.createElement('style');
  style.textContent = `
    #${ID} .intro-title {
      font-family: "Space Grotesk Variable", sans-serif;
      font-size: 120px; font-weight: 700; letter-spacing: -3px;
      animation: intro-rise 1.2s cubic-bezier(.2,.8,.2,1) both;
    }
    /* The narration's words, for a viewer with the sound off. */
    #${ID} .intro-caption {
      position: absolute; left: 80px; right: 80px; bottom: 80px;
      font-size: 40px; color: #cbd5e1; text-align: center;
    }
    #${ID} .intro-caption span { opacity: 0; }
    @keyframes intro-rise {
      from { opacity: 0; transform: translateY(40px); }
      to   { opacity: 1; transform: none; }
    }
  `;
  document.head.append(style);

  const scene = document.createElement('div');
  scene.id = ID;
  scene.className = 'scene clip';
  scene.dataset.start = String(start);
  scene.dataset.duration = String(DURATION);
  const words = 'An agent, a workspace, and every turn a commit.'.split(' ');
  scene.innerHTML = `
    <div class="scene-in"><div class="scene-out" style="--out: ${DURATION - 0.5}s">
      <div class="intro-title">Meet agex studio</div>
      <div class="intro-caption">${words.map((w) => `<span>${w}</span>`).join(' ')}</div>
    </div></div>`;

  // The narration: a clip like any other, on the video's clock, its
  // URL from appAssets.
  const voice = document.createElement('audio');
  voice.id = `${ID}-voice`;
  voice.className = 'clip';
  voice.src = window.appAssets['audio/intro.ogg'];
  voice.dataset.start = String(start + 0.4);
  voice.dataset.duration = String(VOICE);

  document.getElementById('root').append(scene, voice);

  // Anime.js: the video's clock, in milliseconds. The caption's words
  // come in across the voice, one step for all of them.
  const at = (seconds) => (start + seconds) * 1000;
  const tl = anime.createTimeline({ autoplay: false });
  tl.add(`#${ID} .intro-caption span`, {
    opacity: [0, 1],
    duration: 300,
    delay: anime.stagger((VOICE * 1000) / words.length),
    ease: 'linear',
  }, at(0.4));
  window.__hfAnime = window.__hfAnime || [];
  window.__hfAnime.push(tl);
}
