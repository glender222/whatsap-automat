import Navbar from "../components/Navbar";
import HeroSection from "../components/HeroSection";
import HowItWorks from "../components/HowItWorks";
import PricingSection from "../components/PricingSection";
import ContactSection from "../components/ContactSection";

export default function LandingPage() {
  return (
    <div className="bg-white text-gray-900">
      <Navbar />
      <main className="flex flex-col items-center">
        <HeroSection />
        <HowItWorks />
        <PricingSection />
        <ContactSection />
      </main>
    </div>
  );
}
