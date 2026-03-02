# 🎨 Boardly --- Real-Time Collaborative Whiteboard

A production-ready collaborative whiteboard built with **React +
TypeScript + HTML5 Canvas** on the frontend and a **WebSocket server
(Node.js)** on the backend.

This project started as a local drawing engine and evolved into a
real-time, multi-user system deployed across **Vercel (frontend)** and
**Render (WebSocket backend)**.

------------------------------------------------------------------------

## 🚀 Live Demo

👉 https://boardly-fawn-sigma.vercel.app/

------------------------------------------------------------------------

## 🧠 What This Project Really Is

Boardly is not just a drawing app.

It is: - A deterministic canvas rendering engine - A real-time WebSocket
synchronization system - A production deployment case study (Vercel +
Render) - A deep dive into debugging real-world frontend + backend
integration issues

------------------------------------------------------------------------

## 🏗 Architecture Overview

    Client (React + Canvas)
            ↓
    WebSocket (WSS)
            ↓
    Node.js Server (Rooms + Broadcast)

### Frontend

-   React + TypeScript
-   Vite build system
-   Deterministic canvas renderer
-   WebSocket client

### Backend

-   Node.js
-   WebSocket (ws)
-   In-memory room state
-   Snapshot + incremental broadcast model

### Deployment

-   **Frontend → Vercel**
-   **WebSocket server → Render**
-   Secure `wss://` communication

------------------------------------------------------------------------

## ✨ Features

-   Freehand drawing with smooth brush interpolation
-   Multiple shape tools (rectangle, circle, triangle, star, heart,
    umbrella, etc.)
-   Selection and transformation system
-   Undo / redo (scoped per user)
-   Real-time multi-user drawing
-   Cursor ghost / presence indicators
-   Room-based collaboration
-   Late-join snapshot synchronization
-   Clean separation between UI, state, and renderer

------------------------------------------------------------------------

## 🛠 Tech Stack

**Frontend** - React - TypeScript - Vite - HTML5 Canvas API - Modern CSS

**Backend** - Node.js - WebSocket (ws)

**Deployment** - Vercel - Render

------------------------------------------------------------------------

## 🚀 Getting Started (Local)

``` bash
npm install
npm run dev
```

Open:

http://localhost:5173

------------------------------------------------------------------------

## ⚙️ Engineering Decisions & Problems Solved

### 🔹 Deterministic Canvas Rendering

**Problem**\
Incremental canvas drawing caused: - Undo/redo inconsistencies - Visual
artifacts - Hard-to-debug state mutations

**Solution**\
Adopted a state replay model: - All strokes and shapes are stored as
data - Canvas is fully redrawn from state - Undo/redo becomes
deterministic

------------------------------------------------------------------------

### 🔹 Normalizing Shape Geometry

**Problem**\
Shapes behaved differently based on drag direction.

**Solution**\
All shapes are normalized: - Top-left origin - Positive width/height -
Direction-agnostic math

------------------------------------------------------------------------

### 🔹 Decoupling UI From Rendering

**Problem**\
Directly drawing inside UI event handlers created fragile logic.

**Solution** - UI updates application state - Renderer consumes state
and draws

------------------------------------------------------------------------

## 🌐 Real-Time Collaboration Engineering

### 🔹 WebSocket Room Model

-   Each client joins a room
-   Server tracks clients per room
-   Events are broadcast only within the room

------------------------------------------------------------------------

### 🔹 Snapshot + Incremental Sync

**Problem**\
Late joiners saw an empty board.

**Solution** - Server sends a full snapshot on join - Subsequent updates
are incremental

------------------------------------------------------------------------

### 🔹 Undo Isolation

**Problem**\
Global undo breaks collaboration.

**Solution** - Each element is tagged with an owner - Undo only affects
the creator's strokes

------------------------------------------------------------------------

## 🐛 Major Production Bugs & Fixes

### ❌ WebSocket Worked Locally but Failed in Production

**Cause** Client constructed WebSocket URL using window.location,
resulting in: wss://vercel-domain:8787

**Fix** - Enforced usage of VITE_WS_URL - Normalized protocol handling -
Removed production localhost fallbacks

------------------------------------------------------------------------

### ❌ npm Registry Timeouts on Render

**Cause** Lockfiles contained resolved URLs pointing to an internal
registry.

**Fix** - Removed poisoned lockfiles - Forced npmjs registry - Cleared
Render build cache

------------------------------------------------------------------------

### ❌ Localhost Assumptions Leaking Into Production

**Fix** Strict environment-based configuration and no production
fallback to localhost.

------------------------------------------------------------------------

## 🎯 Design Goals

-   Explore low-level canvas graphics programming
-   Build scalable frontend architecture
-   Implement real-time collaboration correctly
-   Handle real deployment edge cases
-   Write maintainable TypeScript

------------------------------------------------------------------------

## 🔮 Future Improvements

-   Layer system
-   SVG / PNG export
-   Persistent storage (auth + save boards)
-   Redis-backed scaling
-   Rate limiting
-   Plugin architecture

------------------------------------------------------------------------

## 📄 License

MIT License

------------------------------------------------------------------------

## 🙌 Author

Built as a fullstack + real-time engineering portfolio project.

🔗 https://mehrabdev.com
