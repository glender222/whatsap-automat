export default function AppLogo() {
  return (
    <div className="p-4 border-b border-gray-200 flex justify-center">
      <div className="w-10 h-10 bg-green-500 rounded-full flex items-center justify-center cursor-pointer hover:bg-green-600 transition-colors shadow-sm">
        <div className="w-6 h-6 bg-white rounded-full flex items-center justify-center">
          <span className="text-green-500 text-xs font-bold">W</span>
        </div>
      </div>
    </div>
  );
}
