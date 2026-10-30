import { Link } from "react-router-dom";
import { useState } from "react";
import { Menu, X } from "lucide-react";
import Button from "./Button";

export default function Navbar() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <nav className="bg-white shadow-sm sticky top-0 z-50">
      <div className="max-w-7xl mx-auto flex justify-between items-center px-4 md:px-6 lg:px-10 py-4">
        <Link to="/" className="flex items-center gap-2 md:gap-3">
          {/* WhatsApp Button */}
          <div className="w-8 h-8 md:w-10 md:h-10 bg-green-500 rounded-full flex items-center justify-center cursor-pointer hover:bg-green-600 transition-colors flex-shrink-0">
            <div className="w-5 h-5 md:w-6 md:h-6 bg-white rounded-full flex items-center justify-center">
              <span className="text-green-500 text-xs font-bold">W</span>
            </div>
          </div>
          <h1 className="font-semibold text-base md:text-lg truncate">Gestión de mensajería</h1>
        </Link>

        {/* Desktop Menu */}
        <div className="hidden md:flex items-center gap-6">
          <a href="#producto" className="text-gray-600 hover:text-gray-900 text-sm lg:text-base">Producto</a>
          <a href="#funciones" className="text-gray-600 hover:text-gray-900 text-sm lg:text-base">Funciones</a>
          <a href="#precios" className="text-gray-600 hover:text-gray-900 text-sm lg:text-base">Precios</a>
          <Link to="/auth/register">
            <Button text="Regístrate gratis" />
          </Link>
        </div>

        {/* Mobile Menu Button */}
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="md:hidden p-2 rounded-md hover:bg-gray-100 transition-colors"
          aria-label="Toggle menu"
        >
          {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div className="md:hidden border-t border-gray-200 bg-white">
          <div className="px-4 py-4 space-y-3">
            <a 
              href="#producto" 
              className="block py-2 text-gray-600 hover:text-gray-900"
              onClick={() => setMobileMenuOpen(false)}
            >
              Producto
            </a>
            <a 
              href="#funciones" 
              className="block py-2 text-gray-600 hover:text-gray-900"
              onClick={() => setMobileMenuOpen(false)}
            >
              Funciones
            </a>
            <a 
              href="#precios" 
              className="block py-2 text-gray-600 hover:text-gray-900"
              onClick={() => setMobileMenuOpen(false)}
            >
              Precios
            </a>
            <Link to="/auth/register" className="block" onClick={() => setMobileMenuOpen(false)}>
              <Button text="Regístrate gratis" className="w-full" />
            </Link>
          </div>
        </div>
      )}
    </nav>
  );
}
