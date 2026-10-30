import { useState } from 'react';
import type { Station } from '../types/Station';

export function useModals() {
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false);
  const [showViewCredentials, setShowViewCredentials] = useState<boolean>(false);
  const [showEditStation, setShowEditStation] = useState<boolean>(false);
  const [showChangePassword, setShowChangePassword] = useState<boolean>(false);
  const [selectedStation, setSelectedStation] = useState<Station | null>(null);

  const openCreateModal = () => setShowCreateModal(true);
  const closeCreateModal = () => setShowCreateModal(false);

  const openViewCredentials = (station: Station) => {
    setSelectedStation(station);
    setShowViewCredentials(true);
  };

  const closeViewCredentials = () => {
    setShowViewCredentials(false);
    setSelectedStation(null);
  };

  const openEditStation = (station: Station) => {
    setSelectedStation(station);
    setShowEditStation(true);
  };

  const closeEditStation = () => {
    setShowEditStation(false);
    setSelectedStation(null);
  };

  const openChangePassword = (station: Station) => {
    setSelectedStation(station);
    setShowChangePassword(true);
  };

  const closeChangePassword = () => {
    setShowChangePassword(false);
    setSelectedStation(null);
  };

  return {
    // States
    showCreateModal,
    showViewCredentials,
    showEditStation,
    showChangePassword,
    selectedStation,
    
    // Create Modal
    openCreateModal,
    closeCreateModal,
    
    // View Credentials Modal
    openViewCredentials,
    closeViewCredentials,
    
    // Edit Station Modal
    openEditStation,
    closeEditStation,
    
    // Change Password Modal
    openChangePassword,
    closeChangePassword
  };
}