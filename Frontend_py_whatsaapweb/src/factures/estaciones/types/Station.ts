export interface Station {
  id: string;
  nombre: string;
  estado: string;
  rol: string;
  etiquetasBot: string[];
  email: string;
}

export interface ToastProps {
  message: string;
  onClose: () => void;
}

export interface StationCardProps {
  station: Station;
  isCurrentUser: boolean;
  onViewCredentials?: (station: Station) => void;
  onEditStation?: (station: Station) => void;
  onChangePassword?: (station: Station) => void;
  onDelete?: (station: Station) => void;
}

export interface CreateStationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (nombre: string, email: string, password?: string) => Promise<void>;
  currentUserEmail: string;
}

export interface ViewCredentialsModalProps {
  isOpen: boolean;
  onClose: () => void;
  station: Station | null;
}

export interface EditStationModalProps {
  isOpen: boolean;
  onClose: () => void;
  station: Station | null;
  onSave: (id: string, nombre: string, email: string) => Promise<void>;
}

export interface ChangePasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
  station: Station | null;
  onSave: (id: string, newPassword: string) => Promise<void>;
}

export interface PasswordStrength {
  length: boolean;
  hasNumber: boolean;
  hasSpecial: boolean;
}