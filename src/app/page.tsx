import { SandpiApp } from "@/components/sandpi-app";
import { getMockBootstrap } from "@/lib/mock-data";

export default function HomePage() {
  return <SandpiApp initialData={getMockBootstrap()} />;
}
