import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useUi } from '../../components/ui.jsx';

export function useSave(reload) {
  const { toast } = useUi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = async (patch, msg = 'Settings saved') => {
    setBusy(true);
    setError(null);
    try {
      await api.put('/api/settings', patch);
      toast(msg);
      await reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, save };
}
