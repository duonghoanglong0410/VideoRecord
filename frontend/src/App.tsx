import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './app/authStore';
import { AppRoutes } from './app/router';

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}

