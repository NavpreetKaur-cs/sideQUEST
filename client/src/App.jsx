import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import "./App.css";
import "./Redesign.css";
import { AuthProvider } from "./context/AuthContext";
import AuthLayout from "./layouts/AuthLayout";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import Register from "./pages/Register";
import GuestPortal from "./pages/GuestPortal";
import { useAuth } from "./hooks/useAuth";

function Portal() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <main className="protected-loading">Loading sideQUEST...</main>;
  // Keep one Dashboard instance for every authenticated route. Previously play
  // and discover used a separate route branch, unmounting Dashboard (and its
  // lounge socket) whenever a player navigated to those pages.
  if (user) return <Dashboard />;
  return ["/discover", "/play"].some((path) => location.pathname === path || location.pathname.startsWith(`${path}/`))
    ? <GuestPortal />
    : <Navigate to="/login" replace state={{ from: location.pathname }} />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route element={<AuthLayout />}>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
          </Route>
          <Route path="/*" element={<Portal />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
