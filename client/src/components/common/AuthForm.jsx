import { AtSign, ArrowRight, LoaderCircle, LockKeyhole, UserRound } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth";
import api from "../../services/api";

export default function AuthForm({ mode }) {
  const isRegister = mode === "register";
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function continueWithGoogle() {
    setError("");
    setSubmitting(true);
    try {
      const { data } = await api.get("/auth/google/url");
      window.location.assign(data.url);
    } catch (requestError) {
      setError(requestError.response?.data?.message || requestError.message || "Google sign-in could not be started.");
      setSubmitting(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    const fields = Object.fromEntries(new FormData(event.currentTarget).entries());

    try {
      if (isRegister) await register(fields);
      else await login(fields);
      navigate("/", { replace: true });
    } catch (requestError) {
      setError(requestError.response?.data?.message || "Could not reach the server. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="auth-topline">
        {isRegister ? "Already have an account?" : "New around here?"}
        <Link to={isRegister ? "/login" : "/register"}>{isRegister ? "Sign in" : "Create account"}</Link>
      </div>
      <section className="auth-form-wrap">
        <span className="form-kicker">{isRegister ? "Build your sideQUEST identity" : "Access your sideQUEST"}</span>
        <h2>{isRegister ? "Make room for good games." : "Pick up where you left off."}</h2>
        <p className="form-intro">
          {isRegister ? "Create an account to find your people and play together." : "Your friends and favorite worlds are waiting."}
        </p>
        <form className="auth-form" onSubmit={handleSubmit}>
          {isRegister && (
            <div className="form-field">
              <label htmlFor="username">Username</label>
              <div className="input-wrap">
                <UserRound className="input-icon" size={17} />
                <input autoComplete="username" id="username" name="username" placeholder="your_handle"
                  minLength={3} maxLength={24} pattern="[A-Za-z0-9_]+"
                  title="Use 3-24 letters, numbers, or underscores" required />
              </div>
            </div>
          )}
          <div className="form-field">
            <label htmlFor="email">Email address</label>
            <div className="input-wrap">
              <AtSign className="input-icon" size={17} />
              <input autoComplete="email" id="email" name="email" placeholder="you@example.com"
                type="email" maxLength={254} required />
            </div>
          </div>
          <div className="form-field">
            <label htmlFor="password">Password</label>
            <div className="input-wrap">
              <LockKeyhole className="input-icon" size={17} />
              <input autoComplete={isRegister ? "new-password" : "current-password"}
                id="password" name="password"
                placeholder={isRegister ? "At least 8 characters" : "Enter your password"}
                type="password" minLength={isRegister ? 8 : 1} maxLength={72} required />
            </div>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="submit-button" type="submit" disabled={submitting}>
            {submitting && <LoaderCircle size={17} className="spin" />}
            {submitting ? "One moment" : isRegister ? "Create account" : "Sign in"}
            {!submitting && <ArrowRight size={17} />}
          </button>
        </form>
        <button className="google-button" type="button" onClick={continueWithGoogle} disabled={submitting}>
          Continue with Google
        </button>
        <p className="auth-note">By continuing, you agree to keep this a good place to be.</p>
      </section>
    </>
  );
}
