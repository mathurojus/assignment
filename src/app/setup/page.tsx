import { SetupPanel } from "@/components/setup-panel";

export const metadata = {
  title: "Setup",
  description: "What Vantage has configured, and what each missing piece would block.",
};

/**
 * `/setup`
 *
 * A real page rather than a modal or a banner, because there is something here
 * worth reading: why the pooler connection string, why image-to-video needs a
 * public origin, and the fact that OpenRouter has no free tier. Those are the
 * things that cost somebody an hour otherwise.
 */
export default function SetupPage() {
  return <SetupPanel />;
}