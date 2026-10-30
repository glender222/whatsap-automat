
import { useState } from 'react';
import { User, Search, Plus, Key } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Toast } from '../components/Toast';
import { StationCard } from '../components/StationCard';
import {
  CreateStationModal,
  ViewCredentialsModal,
  EditStationModal,
  ChangePasswordModal
} from '../components/modals';
import { useStations } from '../hooks/useStations';
import { useModals } from '../hooks/useModals';
import { useToast } from '../hooks/useToast';
import { useStationOperations } from '../hooks/useStationOperations';
import '../styles/animations.css';


export default function AdministradorEstaciones() {
  const navigate = useNavigate();
  const [search, setSearch] = useState<string>('');

  // Usar los hooks personalizados
  const { currentUser, stations, loading, refreshEmployees } = useStations();
  const { toast, showToast, hideToast } = useToast();
  const {
    showCreateModal,
    showViewCredentials,
    showEditStation,
    showChangePassword,
    selectedStation,
    openCreateModal,
    closeCreateModal,
    openViewCredentials,
    closeViewCredentials,
    openEditStation,
    closeEditStation,
    openChangePassword,
    closeChangePassword
  } = useModals();

  const {
    handleCreateStation,
    handleEditStation,
    handleChangePassword,
    handleDeleteStation
  } = useStationOperations(refreshEmployees, showToast);

  // Filtrar estaciones por búsqueda
  const filteredStations = stations.filter((s) => 
    s.nombre.toLowerCase().includes(search.toLowerCase()) ||
    s.email?.toLowerCase().includes(search.toLowerCase())
  );

  // Wrapper functions para los modales
  const onCreateStation = async (nombre: string, email: string, password?: string) => {
    try {
      await handleCreateStation(nombre, email, password);
      closeCreateModal();
    } catch (err) {
      // Error ya manejado en handleCreateStation
    }
  };

  const onEditStation = async (id: string, nombre: string, email: string) => {
    try {
      await handleEditStation(id, nombre, email);
      closeEditStation();
    } catch (err) {
      // Error ya manejado en handleEditStation
    }
  };

  const onChangePassword = async (id: string, newPassword: string) => {
    try {
      await handleChangePassword(id, newPassword);
      closeChangePassword();
    } catch (err) {
      // Error ya manejado en handleChangePassword
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50 dark:bg-gray-900">
        <span className="text-gray-500 dark:text-gray-400 text-lg">Cargando estaciones...</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800">

      {/* Header */}
      <div className="sticky top-0 z-40 bg-white/80 dark:bg-gray-800/80 backdrop-blur-xl border-b border-gray-200 dark:border-gray-700 shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-5">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
        <div className="w-12 h-12 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-2xl flex items-center justify-center shadow-lg">
          <User className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Gestión de Estaciones</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2 mt-0.5">
                  <span className="w-2 h-2 bg-emerald-500 rounded-full"></span>
                  {filteredStations.length} estaciones activas
                </p>
              </div>
            </div>
            <div className="flex flex-col md:flex-row gap-3 w-full md:w-auto">
              {/* Admin Only: Permission Management Button */}
              {currentUser?.rol === 'ADMIN' && (
                <button
                  type="button"
                  onClick={() => navigate('/gestion-web/permisos')}
                  className="bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white px-5 py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all shadow-lg shadow-blue-200 dark:shadow-blue-900/50 hover:shadow-xl"
                >
                  <Key className="w-4 h-4" />
                  Gestionar Permisos
                </button>
              )}
              {/* Search */}
              <div className="relative w-full md:w-80">
                <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 text-gray-400 dark:text-gray-500 w-5 h-5" />
                <input
                  type="text"
                  placeholder="Buscar por nombre o email..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-12 pr-4 py-3 border-2 border-gray-200 dark:border-gray-600 rounded-xl focus:outline-none focus:border-emerald-500 dark:focus:border-emerald-400 transition-colors bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredStations.map((station) => (
            <StationCard
              key={station.id}
              station={station}
              isCurrentUser={station.id === currentUser?.id}
              onViewCredentials={openViewCredentials}
              onEditStation={openEditStation}
              onChangePassword={openChangePassword}
              onDelete={handleDeleteStation}
            />
          ))}
        </div>
        {filteredStations.length === 0 && (
          <div className="text-center py-16">
            <div className="w-20 h-20 bg-gray-100 dark:bg-gray-700 rounded-full flex items-center justify-center mx-auto mb-4">
              <Search className="w-10 h-10 text-gray-400 dark:text-gray-500" />
            </div>
            <h3 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">No se encontraron estaciones</h3>
            <p className="text-gray-500 dark:text-gray-400">Intenta con otro término de búsqueda</p>
          </div>
        )}
      </div>

      {/* Floating Action Button - Solo para ADMIN */}
      {currentUser?.rol === 'ADMIN' && (
        <button
          type="button"
          onClick={openCreateModal}
          className="fixed bottom-8 right-8 w-16 h-16 bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700 text-white rounded-2xl shadow-2xl shadow-emerald-300 hover:shadow-3xl flex items-center justify-center transition-all hover:scale-110 group z-50"
        >
          <Plus className="w-7 h-7 transition-transform group-hover:rotate-90" />
        </button>
      )}

      {/* Modals */}
      <CreateStationModal
        isOpen={showCreateModal}
        onClose={closeCreateModal}
        onCreate={onCreateStation}
        currentUserEmail={currentUser?.email || ''}
      />
      
      <ViewCredentialsModal
        isOpen={showViewCredentials}
        onClose={closeViewCredentials}
        station={selectedStation}
      />
      
      <EditStationModal
        isOpen={showEditStation}
        onClose={closeEditStation}
        station={selectedStation}
        onSave={onEditStation}
      />
      
      <ChangePasswordModal
        isOpen={showChangePassword}
        onClose={closeChangePassword}
        station={selectedStation}
        onSave={onChangePassword}
      />

      {toast && <Toast message={toast} onClose={hideToast} />}
    </div>
  );
}
