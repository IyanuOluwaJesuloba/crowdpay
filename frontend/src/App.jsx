import React, { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Navbar from './components/Navbar';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { ToastProvider } from './context/ToastContext';
import { NetworkStatusProvider } from './context/NetworkStatusContext';
import { OfflineBanner } from './components/OfflineBanner';
import ImpersonationBanner from './components/ImpersonationBanner';
import AnnouncementBanner from './components/AnnouncementBanner';
import { useAuth } from './context/AuthContext';

const Landing = lazy(() => import('./pages/Landing'));
const Home = lazy(() => import('./pages/Home'));
const CreateCampaign = lazy(() => import('./pages/CreateCampaign'));
const Campaign = lazy(() => import('./pages/Campaign'));
const CampaignEmbed = lazy(() => import('./pages/CampaignEmbed'));
const Widget = lazy(() => import('./pages/Widget'));
const Login = lazy(() => import('./pages/Login'));
const Register = lazy(() => import('./pages/Register'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'));
const AcceptInvite = lazy(() => import('./pages/AcceptInvite'));
const Developer = lazy(() => import('./pages/Developer'));
const CampaignCompare = lazy(() => import('./components/CampaignCompare'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Profile = lazy(() => import('./pages/Profile'));
const NotificationSettings = lazy(() => import('./pages/NotificationSettings'));
const TaxReceipts = lazy(() => import('./pages/TaxReceipts'));
const HowItWorks = lazy(() => import('./pages/HowItWorks'));
const Pricing = lazy(() => import('./pages/Pricing'));
const About = lazy(() => import('./pages/About'));
const Resources = lazy(() => import('./pages/Resources'));
const Leaderboard = lazy(() => import('./pages/Leaderboard'));
const NotFound = lazy(() => import('./pages/NotFound'));
const CreatorProfile = lazy(() => import('./pages/CreatorProfile'));
const CreatorAnalytics = lazy(() => import('./pages/CreatorAnalytics'));
const CreatorCampaignAnalytics = lazy(() => import('./pages/CreatorCampaignAnalytics'));
const Governance = lazy(() => import('./pages/Governance'));
const CampaignShare = lazy(() => import('./pages/CampaignShare'));
const ReferralDashboard = lazy(() => import('./pages/ReferralDashboard'));

function PrivateRoute({ children }) {
  const { user, ready } = useAuth();
  if (!ready) return null;
  return user ? children : <Navigate to="/login" replace />;
}

export default function App() {
  const location = useLocation();
  const hideNavbar =
    location.pathname.startsWith('/widget/') || location.pathname.startsWith('/embed/');

  return (
    <ThemeProvider>
      <AuthProvider>
        <ToastProvider>
          <NetworkStatusProvider>
            <OfflineBanner />
            {!hideNavbar && <ImpersonationBanner />}
            {!hideNavbar && <AnnouncementBanner />}
            {!hideNavbar && <Navbar />}
            <Suspense fallback={<div>Loading...</div>}>
              <Routes>
                <Route path="/" element={<Landing />} />
                <Route path="/discover" element={<Home />} />
                <Route path="/compare" element={<CampaignCompare />} />
                <Route path="/how-it-works" element={<HowItWorks />} />
                <Route path="/pricing" element={<Pricing />} />
                <Route path="/about" element={<About />} />
                <Route path="/resources" element={<Resources />} />
                <Route path="/leaderboard" element={<Leaderboard />} />
                <Route path="/creators/:id" element={<CreatorProfile />} />
                <Route
                  path="/campaigns/new"
                  element={
                    <PrivateRoute>
                      <CreateCampaign />
                    </PrivateRoute>
                  }
                />
                <Route path="/campaigns/:id" element={<Campaign />} />
                <Route path="/campaigns/:id/share" element={<CampaignShare />} />
                {/* Short share link handed out by the referral system (#675) */}
                <Route path="/c/:id" element={<Campaign />} />
                <Route path="/campaigns/:id/invite/:token" element={<AcceptInvite />} />
                <Route path="/embed/campaigns/:id" element={<CampaignEmbed />} />
                <Route path="/widget/campaigns/:id" element={<Widget />} />
                <Route path="/login" element={<Login />} />
                <Route path="/register" element={<Register />} />
                <Route path="/forgot-password" element={<ForgotPassword />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                <Route
                  path="/admin"
                  element={
                    <PrivateRoute>
                      <AdminDashboard />
                    </PrivateRoute>
                  }
                />
                <Route
                  path="/developer"
                  element={
                    <PrivateRoute>
                      <Developer />
                    </PrivateRoute>
                  }
                />
                <Route
                  path="/dashboard"
                  element={
                    <PrivateRoute>
                      <Dashboard />
                    </PrivateRoute>
                  }
                />
                <Route
                  path="/dashboard/referrals"
                  element={
                    <PrivateRoute>
                      <ReferralDashboard />
                    </PrivateRoute>
                  }
                />
                <Route
                  path="/dashboard/analytics"
                  element={
                    <PrivateRoute>
                      <CreatorAnalytics />
                    </PrivateRoute>
                  }
                />
                <Route
                  path="/dashboard/analytics/:campaignId"
                  element={
                    <PrivateRoute>
                      <CreatorCampaignAnalytics />
                    </PrivateRoute>
                  }
                />
                <Route
                  path="/profile"
                  element={
                    <PrivateRoute>
                      <Profile />
                    </PrivateRoute>
                  }
                />
                <Route
                  path="/settings/notifications"
                  element={
                    <PrivateRoute>
                      <NotificationSettings />
                    </PrivateRoute>
                  }
                />
                <Route
                  path="/tax-receipts"
                  element={
                    <PrivateRoute>
                      <TaxReceipts />
                    </PrivateRoute>
                  }
                />
                <Route
                  path="/governance"
                  element={<Governance />}
                />
                <Route
                  path="/my-contributions"
                  element={<Navigate to="/dashboard?tab=contributions" replace />}
                />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </NetworkStatusProvider>
        </ToastProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
