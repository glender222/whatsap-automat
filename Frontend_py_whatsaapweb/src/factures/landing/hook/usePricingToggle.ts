import { useState } from "react";

export const usePricingToggle = () => {
  const [isMonthly, setIsMonthly] = useState(true);
  const toggle = () => setIsMonthly((prev) => !prev);
  return { isMonthly, toggle };
};
