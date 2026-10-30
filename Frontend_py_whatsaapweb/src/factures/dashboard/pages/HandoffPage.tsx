import HandoffWidget from '../components/HandoffWidget';

export default function HandoffPage() {
  return (
    <div className="min-h-full bg-[#F7FAF8] p-6 lg:p-10">
      <div className="mx-auto w-full max-w-3xl space-y-6 pb-20">
        <section className="border-b border-[#D9E5DF] pb-5">
          <p className="text-sm font-semibold uppercase text-[#128C7E]">Operaciones IA</p>
          <h2 className="mt-1 text-3xl font-bold text-[#10231C]">Cola de Handoff</h2>
          <p className="mt-2 text-sm text-[#5B6F66]">
            Conversaciones que la IA derivó a humano. Toma un ticket para atender el chat.
          </p>
        </section>
        <HandoffWidget limit={20} status="all" allowClose />
      </div>
    </div>
  );
}
