import { requireUser } from "@/lib/control";
import { ExperimentCreateForm } from "@/components/ExperimentCreateForm";
import { PageMark } from "@/components/ui/PageMark";

export default async function NewExperimentPage({ params, searchParams }: { params: Promise<{ wid: string; sid: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireUser();
  const { wid, sid } = await params;
  return (
    <>
      <PageMark path={`/w/${wid}/sites/${sid}/experiments/new`} search={await searchParams} />
      <ExperimentCreateForm wid={wid} sid={sid} />
    </>
  );
}
