import { redirect } from "next/navigation";
import { controlFetch } from "@/lib/control";

export default async function Home() {
  const r = await controlFetch("/me");
  redirect(r.status === 200 ? "/w" : "/login");
}
