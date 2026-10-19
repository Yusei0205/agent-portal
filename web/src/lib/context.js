import { createContext, useContext } from 'react';

export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);
export const ProjectContext = createContext(null);
export const useProject = () => useContext(ProjectContext);
