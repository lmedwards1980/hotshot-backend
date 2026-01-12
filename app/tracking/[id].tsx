import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Linking,
  Dimensions,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import api from '../../services/api';

const { width, height } = Dimensions.get('window');

const colors = {
  background: '#0a0a0a',
  surface: '#1a1a1a',
  surfaceLight: '#262626',
  primary: '#6366f1',
  text: '#ffffff',
  textSecondary: '#a3a3a3',
  textMuted: '#525252',
  border: '#333333',
  success: '#22c55e',
  warning: '#f59e0b',
  error: '#ef4444',
};

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
  pending: { label: 'Finding Driver', color: colors.warning, icon: 'search' },
  assigned: { label: 'Driver Assigned', color: colors.primary, icon: 'person' },
  en_route_pickup: { label: 'Driver En Route to Pickup', color: colors.warning, icon: 'car' },
  picked_up: { label: 'Picked Up - In Transit', color: colors.success, icon: 'cube' },
  en_route_delivery: { label: 'Out for Delivery', color: colors.success, icon: 'navigate' },
  delivered: { label: 'Delivered', color: colors.success, icon: 'checkmark-circle' },
  cancelled: { label: 'Cancelled', color: colors.error, icon: 'close-circle' },
};

interface LoadDetails {
  id: number;
  status: string;
  pickup_address: string;
  pickup_city: string;
  pickup_state: string;
  pickup_lat: number;
  pickup_lng: number;
  delivery_address: string;
  delivery_city: string;
  delivery_state: string;
  delivery_lat: number;
  delivery_lng: number;
  distance_miles: number;
  price: number;
  driver_id: number | null;
  driver?: {
    id: number;
    first_name: string;
    last_name: string;
    phone: string;
    vehicle_type: string;
    license_plate: string;
    current_lat: number;
    current_lng: number;
    last_location_update: string;
  };
}

export default function TrackingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [load, setLoad] = useState<LoadDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mapRef = useRef<MapView>(null);
  const pollInterval = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    fetchLoadDetails();
    
    // Poll for updates every 5 seconds when load is active
    pollInterval.current = setInterval(() => {
      fetchLoadDetails(true);
    }, 5000);

    return () => {
      if (pollInterval.current) {
        clearInterval(pollInterval.current);
      }
    };
  }, [id]);

  const fetchLoadDetails = async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const response = await api.get(`/loads/${id}`);
      setLoad(response.data);
      setError(null);
      
      // Stop polling if delivered or cancelled
      if (['delivered', 'cancelled'].includes(response.data.status)) {
        if (pollInterval.current) {
          clearInterval(pollInterval.current);
        }
      }
    } catch (err: any) {
      if (!silent) {
        setError(err.response?.data?.error || 'Failed to load tracking info');
      }
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const fitMapToMarkers = () => {
    if (!mapRef.current || !load) return;
    
    const coordinates = [
      { latitude: load.pickup_lat, longitude: load.pickup_lng },
      { latitude: load.delivery_lat, longitude: load.delivery_lng },
    ];
    
    if (load.driver?.current_lat && load.driver?.current_lng) {
      coordinates.push({
        latitude: load.driver.current_lat,
        longitude: load.driver.current_lng,
      });
    }
    
    mapRef.current.fitToCoordinates(coordinates, {
      edgePadding: { top: 100, right: 50, bottom: 300, left: 50 },
      animated: true,
    });
  };

  const callDriver = () => {
    if (load?.driver?.phone) {
      Linking.openURL(`tel:${load.driver.phone}`);
    }
  };

  const textDriver = () => {
    if (load?.driver?.phone) {
      Linking.openURL(`sms:${load.driver.phone}`);
    }
  };

  const getETAText = () => {
    if (!load?.driver?.current_lat || !load.driver?.current_lng) return 'Calculating...';
    
    let targetLat, targetLng;
    if (['assigned', 'en_route_pickup'].includes(load.status)) {
      targetLat = load.pickup_lat;
      targetLng = load.pickup_lng;
    } else {
      targetLat = load.delivery_lat;
      targetLng = load.delivery_lng;
    }
    
    const distance = calculateDistance(
      load.driver.current_lat, load.driver.current_lng,
      targetLat, targetLng
    );
    
    const minutes = Math.round((distance / 45) * 60);
    if (minutes < 1) return 'Arriving';
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes/60)}h ${minutes % 60}m`;
  };

  const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 3959;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c * 1.3;
  };

  const getLastUpdateText = () => {
    if (!load?.driver?.last_location_update) return '';
    const lastUpdate = new Date(load.driver.last_location_update);
    const now = new Date();
    const diffSeconds = Math.floor((now.getTime() - lastUpdate.getTime()) / 1000);
    if (diffSeconds < 10) return 'Just now';
    if (diffSeconds < 60) return `${diffSeconds}s ago`;
    if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
    return lastUpdate.toLocaleTimeString();
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>Loading tracking info...</Text>
      </View>
    );
  }

  if (error || !load) {
    return (
      <View style={styles.errorContainer}>
        <Ionicons name="alert-circle" size={48} color={colors.error} />
        <Text style={styles.errorText}>{error || 'Load not found'}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => fetchLoadDetails()}>
          <Text style={styles.retryBtnText}>Retry</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.backLink} onPress={() => router.back()}>
          <Text style={styles.backLinkText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const statusConfig = STATUS_CONFIG[load.status] || STATUS_CONFIG.pending;
  const hasDriver = load.driver && load.driver_id;
  const hasDriverLocation = hasDriver && load.driver?.current_lat && load.driver?.current_lng;

  return (
    <View style={styles.container}>
      {/* Map */}
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={PROVIDER_GOOGLE}
        initialRegion={{
          latitude: (load.pickup_lat + load.delivery_lat) / 2,
          longitude: (load.pickup_lng + load.delivery_lng) / 2,
          latitudeDelta: Math.abs(load.pickup_lat - load.delivery_lat) * 1.5 + 0.1,
          longitudeDelta: Math.abs(load.pickup_lng - load.delivery_lng) * 1.5 + 0.1,
        }}
        onMapReady={fitMapToMarkers}
        customMapStyle={darkMapStyle}
      >
        {/* Pickup */}
        <Marker coordinate={{ latitude: load.pickup_lat, longitude: load.pickup_lng }} title="Pickup">
          <View style={styles.markerContainer}>
            <View style={[styles.marker, { backgroundColor: colors.success }]}>
              <Ionicons name="arrow-up" size={16} color="#fff" />
            </View>
          </View>
        </Marker>

        {/* Delivery */}
        <Marker coordinate={{ latitude: load.delivery_lat, longitude: load.delivery_lng }} title="Delivery">
          <View style={styles.markerContainer}>
            <View style={[styles.marker, { backgroundColor: colors.error }]}>
              <Ionicons name="arrow-down" size={16} color="#fff" />
            </View>
          </View>
        </Marker>

        {/* Driver */}
        {hasDriverLocation && (
          <Marker
            coordinate={{ latitude: load.driver!.current_lat, longitude: load.driver!.current_lng }}
            title={`${load.driver!.first_name}'s Location`}
          >
            <View style={styles.driverMarkerContainer}>
              <View style={styles.driverMarker}>
                <Ionicons name="car" size={20} color="#fff" />
              </View>
            </View>
          </Marker>
        )}

        {/* Route Line */}
        <Polyline
          coordinates={[
            { latitude: load.pickup_lat, longitude: load.pickup_lng },
            { latitude: load.delivery_lat, longitude: load.delivery_lng },
          ]}
          strokeColor={colors.primary}
          strokeWidth={3}
          lineDashPattern={[10, 5]}
        />
      </MapView>

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Track Shipment</Text>
        <TouchableOpacity style={styles.refreshBtn} onPress={() => fetchLoadDetails()}>
          <Ionicons name="refresh" size={24} color={colors.text} />
        </TouchableOpacity>
      </View>

      {/* Bottom Card */}
      <View style={styles.bottomCard}>
        {/* Status */}
        <View style={[styles.statusBanner, { backgroundColor: statusConfig.color + '20' }]}>
          <Ionicons name={statusConfig.icon as any} size={20} color={statusConfig.color} />
          <Text style={[styles.statusText, { color: statusConfig.color }]}>{statusConfig.label}</Text>
          {hasDriverLocation && (
            <Text style={styles.etaText}>ETA: {getETAText()}</Text>
          )}
        </View>

        {/* Route */}
        <View style={styles.routeInfo}>
          <View style={styles.locationRow}>
            <View style={[styles.dot, { backgroundColor: colors.success }]} />
            <View style={styles.locationText}>
              <Text style={styles.locationLabel}>Pickup</Text>
              <Text style={styles.locationCity}>{load.pickup_city}, {load.pickup_state}</Text>
            </View>
          </View>
          <View style={styles.routeLine}>
            <Text style={styles.distanceText}>{load.distance_miles} mi</Text>
          </View>
          <View style={styles.locationRow}>
            <View style={[styles.dot, { backgroundColor: colors.error }]} />
            <View style={styles.locationText}>
              <Text style={styles.locationLabel}>Delivery</Text>
              <Text style={styles.locationCity}>{load.delivery_city}, {load.delivery_state}</Text>
            </View>
          </View>
        </View>

        {/* Driver */}
        {hasDriver ? (
          <View style={styles.driverSection}>
            <View style={styles.driverInfo}>
              <View style={styles.driverAvatar}>
                <Ionicons name="person" size={24} color={colors.text} />
              </View>
              <View style={styles.driverDetails}>
                <Text style={styles.driverName}>{load.driver!.first_name} {load.driver!.last_name}</Text>
                <Text style={styles.driverVehicle}>{load.driver!.vehicle_type || 'Vehicle'} • {load.driver!.license_plate || 'N/A'}</Text>
                {hasDriverLocation && (
                  <Text style={styles.lastUpdate}>Updated {getLastUpdateText()}</Text>
                )}
              </View>
            </View>
            <View style={styles.contactButtons}>
              <TouchableOpacity style={styles.contactBtn} onPress={callDriver}>
                <Ionicons name="call" size={20} color={colors.success} />
                <Text style={styles.contactBtnText}>Call</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.contactBtn} onPress={textDriver}>
                <Ionicons name="chatbubble" size={20} color={colors.primary} />
                <Text style={styles.contactBtnText}>Text</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View style={styles.noDriverSection}>
            <ActivityIndicator size="small" color={colors.warning} />
            <Text style={styles.noDriverText}>Looking for drivers...</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const darkMapStyle = [
  { elementType: 'geometry', stylers: [{ color: '#212121' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#757575' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#212121' }] },
  { featureType: 'road', elementType: 'geometry.fill', stylers: [{ color: '#2c2c2c' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3c3c3c' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#000000' }] },
];

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  loadingContainer: { flex: 1, backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' },
  loadingText: { color: colors.textSecondary, marginTop: 12, fontSize: 16 },
  errorContainer: { flex: 1, backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center', padding: 20 },
  errorText: { color: colors.error, fontSize: 16, textAlign: 'center', marginTop: 12 },
  retryBtn: { backgroundColor: colors.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10, marginTop: 20 },
  retryBtnText: { color: colors.text, fontSize: 16, fontWeight: '600' },
  backLink: { marginTop: 16 },
  backLinkText: { color: colors.textSecondary, fontSize: 14 },
  map: { ...StyleSheet.absoluteFillObject },
  header: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 50, paddingHorizontal: 16, paddingBottom: 12 },
  backBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '600', color: colors.text },
  refreshBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface, justifyContent: 'center', alignItems: 'center' },
  bottomCard: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 34 },
  statusBanner: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 20, borderTopLeftRadius: 24, borderTopRightRadius: 24, gap: 8 },
  statusText: { fontSize: 15, fontWeight: '600', flex: 1 },
  etaText: { fontSize: 14, fontWeight: '700', color: colors.text, backgroundColor: colors.surfaceLight, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  routeInfo: { padding: 20, borderBottomWidth: 1, borderBottomColor: colors.surfaceLight },
  locationRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  locationText: { flex: 1 },
  locationLabel: { fontSize: 12, color: colors.textMuted },
  locationCity: { fontSize: 15, color: colors.text, fontWeight: '500' },
  routeLine: { marginLeft: 5, paddingLeft: 18, borderLeftWidth: 2, borderLeftColor: colors.surfaceLight, paddingVertical: 6 },
  distanceText: { fontSize: 12, color: colors.primary, fontWeight: '600' },
  driverSection: { padding: 20 },
  driverInfo: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  driverAvatar: { width: 50, height: 50, borderRadius: 25, backgroundColor: colors.surfaceLight, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  driverDetails: { flex: 1 },
  driverName: { fontSize: 16, fontWeight: '600', color: colors.text },
  driverVehicle: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  lastUpdate: { fontSize: 11, color: colors.textMuted, marginTop: 4 },
  contactButtons: { flexDirection: 'row', gap: 12 },
  contactBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceLight, paddingVertical: 12, borderRadius: 10, gap: 8 },
  contactBtnText: { fontSize: 14, fontWeight: '600', color: colors.text },
  noDriverSection: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 20, gap: 12 },
  noDriverText: { fontSize: 14, color: colors.warning },
  markerContainer: { alignItems: 'center' },
  marker: { width: 32, height: 32, borderRadius: 16, justifyContent: 'center', alignItems: 'center', borderWidth: 3, borderColor: '#fff' },
  driverMarkerContainer: { alignItems: 'center', justifyContent: 'center' },
  driverMarker: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center', borderWidth: 3, borderColor: '#fff' },
});
