import { usePricingToggle } from "../hook/usePricingToggle";
import type{ PricingPlan } from "../types/pricing";
import Button from "./Button";

const plans: PricingPlan[] = [
  { name: "Gratis", price: 0, features: ["Usuario", "4 máquinas"] },
  { name: "Básico", price: 3, features: ["Usuario", "4 máquinas", "reportes"] },
  { name: "Pro", price: 9, features: ["Usuario", "6 máquinas", "reportes", "bot"] },
  { name: "Profesional", price: 13, features: ["Usuario", "∞ máquinas", "reportes", "bot", "seguimiento"] },
];

export default function PricingSection() {
  const { isMonthly, toggle } = usePricingToggle();

  return (
    <section id="precios" className="py-12 md:py-20 px-4 md:px-10 text-center">
      <h3 className="text-2xl md:text-3xl font-bold mb-6">Precios</h3>

      <div className="flex justify-center gap-2 md:gap-3 mb-6 md:mb-8">
        <button
          onClick={toggle}
          className={`px-4 py-2 rounded-md border ${isMonthly ? "bg-gray-200" : ""}`}
        >
          Mensual
        </button>
        <button
          onClick={toggle}
          className={`px-4 py-2 rounded-md border ${!isMonthly ? "bg-gray-200" : ""}`}
        >
          Anual
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6 max-w-6xl mx-auto">
        {plans.map((plan, i) => (
          <div key={i} className="border rounded-xl p-4 md:p-6 bg-white shadow-sm">
            <h4 className="text-lg md:text-xl font-semibold">{plan.name}</h4>
            <p className="text-2xl md:text-3xl font-bold mt-2">
              S/.{plan.price}
              <span className="text-xs md:text-sm font-normal"> /mes</span>
            </p>
            <ul className="my-3 md:my-4 text-xs md:text-sm text-left space-y-1 md:space-y-2">
              {plan.features.map((f, idx) => (
                <li key={idx}>✓ {f}</li>
              ))}
            </ul>
            <Button text="Elegir plan" className="w-full" />
          </div>
        ))}
      </div>
    </section>
  );
}
