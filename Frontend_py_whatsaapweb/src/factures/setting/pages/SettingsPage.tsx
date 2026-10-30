import React from 'react';
import SettingsModal from '../components/SettingsModal';
import { useNavigate, useLocation } from 'react-router-dom';

const SettingsPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();

  const handleClose = () => {
    // If there's history state with background, go back; otherwise go to inicio
    if (location.state && (location.state as any).background) {
      navigate(-1);
    } else {
      navigate('/gestion-web/inicio');
    }
  };

  return (
    <div>
      <SettingsModal
        open={true}
        onClose={handleClose}
      />
    </div>
  );
};

export default SettingsPage;
