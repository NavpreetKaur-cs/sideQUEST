import { Gamepad2, Sparkles } from "lucide-react";
import { Link, Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

export default function AuthLayout() {
  const { user, loading } = useAuth();
  if (loading) return <main className="protected-loading" role="status">Checking session...</main>;
  if (user) return <Navigate to="/" replace />;

  return (
    <div className="auth-page auth-redesign">
      <header className="auth-masthead">
        <Link className="brand-lockup" to="/login" aria-label="sideQUEST home">
          <span className="brand-mark"><Gamepad2 size={19} /></span>
          <span className="brand-wordmark">sideQUEST<span className="brand-period">.</span></span>
        </Link>
        <span className="auth-masthead-note"><Sparkles size={13} /> THE INDIE PLAY NETWORK</span>
      </header>
      <main className="auth-stage">
        <div className="auth-intro">
          <span className="eyebrow">PLAY / CREATE / BELONG</span>
          <h1>Your next<br />good <em>thing.</em></h1>
          <p>A home for games made with heart and the people you want to play them with.</p>
        </div>
        <section className="auth-card"><Outlet /></section>
      </main>
      <footer className="auth-footer"><span>INDEPENDENT WORLDS. REAL PEOPLE.</span><span>FIND · PLAY · SHARE</span></footer>
    </div>
  );
}