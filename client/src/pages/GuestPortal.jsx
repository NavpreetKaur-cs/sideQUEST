import { Link, useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import api, { gamePlayUrl } from "../services/api";

export default function GuestPortal() {
  const { slug } = useParams();
  const [games, setGames] = useState([]);
  const [game, setGame] = useState(null);
  useEffect(() => { api.get(slug ? `/games/public/${encodeURIComponent(slug)}` : "/games/public", { params: { limit: 48 } }).then(({ data }) => slug ? setGame(data.game) : setGames(data.games || []) ).catch(() => {}); }, [slug]);
  if (slug) return <main className="page-content game-player-page"><header className="game-player-header"><div><span className="eyebrow">sideQUEST</span><h1>{game?.title || "Loading game..."}</h1><p>Sign in to save your progress, like, comment, and invite friends.</p></div><Link className="outline-button" to="/login">Sign in</Link></header>{game && <iframe className="game-player-frame" src={gamePlayUrl(game.publicSlug)} title={game.title} allow="autoplay; fullscreen; gamepad" allowFullScreen />}</main>;
  return <main className="page-content"><header className="page-intro"><div><span className="eyebrow">sideQUEST</span><h1>Discover browser games</h1><p>Play community-made worlds right in your browser.</p></div><Link className="primary-button" to="/login">Sign in</Link></header><section className="trending-grid">{games.map((item) => <Link className="game-discovery-card" key={item.id} to={`/play/${item.publicSlug}`}><img src={item.thumbnail || ""} alt="" /><div className="game-card-meta"><strong>{item.title}</strong><small>{item.genre} · {item.plays} plays</small></div></Link>)}</section></main>;
}
