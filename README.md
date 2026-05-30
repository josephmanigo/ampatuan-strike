# Tactical Strike FPS

A multiplayer 3D First-Person Shooter game built with HTML5, Three.js, Node.js, and Socket.io.

## Features
- **Multiplayer Combat**: Real-time server-authoritative gameplay.
- **Multiple Weapons**: Assault Rifle, Shotgun, Sniper, SMG, Pistol, RPG.
- **Vehicles & Cover**: Tactical map with cars, vans, and barriers.
- **Game Modes**: Team Deathmatch (Red vs Blue).

## Local Development

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Start Server**:
    ```bash
    npm start
    ```

3.  **Play**:
    Open `http://localhost:3000` in your browser.

## Deployment

This game is ready to be deployed to platforms like **Heroku**, **Render**, or **Railway**.

### Deploy to Render / Heroku
1.  Push this repository to GitHub.
2.  Connect your repository to Render/Heroku.
3.  The platform will automatically detect `npm start` from `package.json` (or the `Procfile`).
4.  Ensure the build command is `npm install`.
5.  Deploy!

### Environment Variables
- `PORT`: Automatically set by the hosting provider (defaults to 3000 locally).
