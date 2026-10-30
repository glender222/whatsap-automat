import { useAtom } from 'jotai';
import { globalTransitionAtom } from '../slices/globalTransitionAtom';

export function useGlobalTransition() {
  const [transition, setTransition] = useAtom(globalTransitionAtom);

  const showTransition = (message = 'Cargando...') => {
    setTransition({ show: true, message });
  };

  const hideTransition = () => {
    setTransition({ show: false, message: '' });
  };

  return {
    show: transition.show,
    message: transition.message,
    showTransition,
    hideTransition,
  };
}
