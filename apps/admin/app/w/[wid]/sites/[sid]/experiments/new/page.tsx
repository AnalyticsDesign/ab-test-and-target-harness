import { requireUser } from "@/lib/control";
import { ExperimentCreateForm } from "@/components/ExperimentCreateForm";

export default async function NewExperimentPage({ params }: { params: Promise<{ wid: string; sid: string }> }) {
  await requireUser();
  const { wid, sid } = await params;
  return <ExperimentCreateForm wid={wid} sid={sid} />;
}
