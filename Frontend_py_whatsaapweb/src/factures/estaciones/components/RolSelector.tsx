import React from 'react';

interface RolSelectorProps {
  value: string;
  roles: string[];
}

const RolSelector: React.FC<RolSelectorProps> = ({ value, roles }) => (
  <div className="flex items-center gap-4 mb-4">
    <span className="text-sm font-semibold text-gray-700">ROL</span>
    <select className="bg-blue-500 text-white px-4 py-1.5 rounded-lg font-medium text-sm focus:outline-none focus:ring-2 focus:ring-blue-600" defaultValue={value}>
      {roles.map(r => <option key={r} value={r}>{r}</option>)}
    </select>
  </div>
);

export default RolSelector;
