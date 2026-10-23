import { Console } from "@/components/console";
import { isDbConfigured } from "@/lib/db/client";

export const dynamic = "force-dynamic";

export default function Page() {
  return <Console dbConfigured={isDbConfigured()} />;
}
