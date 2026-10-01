import Link from "next/link";

const projects = [
  ["The Tortoise and the Hare", "FILM · COMMUNITY"],
  ["BESA", "CINEMA · AI FILM"],
  ["Count of Three", "STORY · COMMUNITY"],
  ["Detour", "SHORT FILM · AI"],
];

const effects = ["Floating fall", "High flip", "Burning man", "Studio slide", "Incline", "Act natural"];

export default function HomePage() {
  return (
    <div className="hf-home">
      <section className="hf-hero">
        <div className="hf-hero-art" aria-hidden="true">
          <div className="hf-orb hf-orb-one" />
          <div className="hf-orb hf-orb-two" />
          <div className="hf-hero-glow" />
        </div>
        <div className="hf-hero-copy">
          <span className="hf-eyebrow">YOUR AI CREATIVE STUDIO</span>
          <h1>Make what<br />you <em> imagine.</em></h1>
          <p>One creative studio for images, video, and everything in between.</p>
          <div className="hf-actions">
            <Link className="hf-button hf-button-light" href="/generate">Start creating <span>↗</span></Link>
            <Link className="hf-button hf-button-quiet" href="/explore">Explore creations</Link>
          </div>
          <div className="hf-hero-note"><span className="hf-live-dot" /> A new era of visual storytelling</div>
        </div>
        <div className="hf-hero-caption"><span>01 / 04</span><span>GENJUTSU RESTYLE</span><span>Keep the motion. Change the world.</span></div>
      </section>

      <section className="hf-tools">
        <div className="hf-section-head">
          <div><span className="hf-eyebrow">YOUR IDEAS, IN MOTION</span><h2>Everything starts with a spark.</h2></div>
          <Link href="/generate" className="hf-text-link">Open studio <span>↗</span></Link>
        </div>
        <div className="hf-tool-grid">
          <Link href="/generate?type=image" className="hf-tool-card hf-image-card"><span className="hf-tool-index">01</span><div><span>IMAGE STUDIO</span><h3>Dream it.<br />See it.</h3><p>Turn a thought into a frame.</p></div><span className="hf-card-arrow">↗</span></Link>
          <Link href="/generate?type=video" className="hf-tool-card hf-video-card"><video aria-hidden="true" autoPlay muted loop playsInline preload="metadata" poster="https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd2ol7oe51mr4n9.cloudfront.net%2Fuser_3HHoco5yVBrnJykveIPIqe1y4AP%2F35a6acb4-2e2e-46a6-bd4f-db622b57a38f.png&w=640&q=85"><source src="https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" type="video/mp4" /></video><span className="hf-tool-index">02</span><div><span>VIDEO STUDIO</span><h3>Make every<br />frame move.</h3><p>Bring your ideas to life.</p></div><span className="hf-card-arrow">↗</span></Link>
          <Link href="/generate" className="hf-tool-card hf-effects-card"><span className="hf-tool-index">03</span><div><span>CREATIVE EFFECTS</span><h3>Go beyond<br />the ordinary.</h3><p>Give your next idea a little magic.</p></div><span className="hf-card-arrow">↗</span></Link>
        </div>
      </section>

      <section className="hf-community">
        <div className="hf-section-head"><div><span className="hf-eyebrow">MADE WITH HIGGSFIELD</span><h2>Stories worth a second look.</h2></div><Link href="/explore" className="hf-text-link">Explore all projects <span>↗</span></Link></div>
        <div className="hf-project-grid">{projects.map(([title, label], i) => <Link href="/explore" className={`hf-project hf-project-${i + 1}`} key={title}><div className="hf-project-art"><span>H</span></div><div className="hf-project-meta"><div><h3>{title}</h3><span>{label}</span></div><span className="hf-card-arrow">↗</span></div></Link>)}</div>
      </section>

      <section className="hf-effects">
        <div className="hf-section-head"><div><span className="hf-eyebrow">A DIFFERENT POINT OF VIEW</span><h2>Big-screen energy. One click away.</h2></div><Link href="/generate" className="hf-text-link">Try a camera move <span>↗</span></Link></div>
        <div className="hf-effect-list">{effects.map((effect, i) => <Link href="/generate" className={`hf-effect hf-effect-${i + 1}`} key={effect}><span className="hf-effect-num">0{i + 1}</span><span>{effect}</span><span>↗</span></Link>)}</div>
      </section>

      <section className="hf-bottom"><span className="hf-eyebrow">THE NEXT FRAME IS YOURS</span><h2>Got an idea?<br /><em>Make it real.</em></h2><Link href="/generate" className="hf-button hf-button-light">Open the studio <span>↗</span></Link></section>
    </div>
  );
}
