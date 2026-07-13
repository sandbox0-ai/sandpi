import { SandpiApp } from "@/components/sandpi-app";
import { getMockBootstrap } from "@/lib/mock-data";

interface HomePageProps {
  searchParams: Promise<{ team?: string }>;
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const { team } = await searchParams;
  return <SandpiApp initialData={getMockBootstrap(team)} />;
}
