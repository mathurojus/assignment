import { SetupPanel } from "@/components/setup-panel";

export const metadata = {
  title: "Setup",
  description: "What Vantage has configured, and what each missing piece would block.",
};

/**
 * Always rendered per request.
 *
 * Without this the page is prerendered at build time, and it is a page whose
 * entire content is "what is configured right now" — so a build that captured
 * the environment at build time reports that state forever. On Vercel the
 * variables exist at build time too, which is why it usually looks right; the
 * failure shows up when it does not: `npm run build` on a fresh clone with no
 * `.env.local`, then adding the key and running `npm start`, produces a page that
 * insists the key is missing while the app generates happily.
 *
 * A diagnostic page that can be stale is worse than one that is slightly slower
 * to render, so it is forced dynamic.
 */
export const dynamic = "force-dynamic";

/**
 * `/setup`
 *
 * A real page rather than a modal or a banner, because there is something here
 * worth reading: why the pooler connection string, why image-to-video needs a
 * public origin, and the precise shape of OpenRouter's free tier — it exists for
 * text models and covers no media model at all. Those are the things that cost
 * somebody an hour otherwise.
 */
export default function SetupPage() {
  return <SetupPanel />;
}