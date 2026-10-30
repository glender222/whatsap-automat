interface ButtonProps {
  text: string;
  variant?: "solid" | "outline";
  className?: string;
}

export default function Button({
  text,
  variant = "solid",
  className = "",
}: ButtonProps) {
  const base = "rounded-md px-6 py-2 font-medium transition";
  const styles =
    variant === "solid"
      ? "bg-green-500 text-white hover:bg-green-600"
      : "border border-gray-400 text-gray-700 hover:bg-gray-100";

  return <button className={`${base} ${styles} ${className}`}>{text}</button>;
}
