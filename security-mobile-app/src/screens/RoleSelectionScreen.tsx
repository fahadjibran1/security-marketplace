import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AppRole } from '../types/models';

interface RoleSelectionScreenProps {
  onSelectRole: (role: AppRole) => void;
}

export function RoleSelectionScreen({ onSelectRole }: RoleSelectionScreenProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Security Operations App</Text>
      <Text style={styles.subtitle}>Choose your dashboard to continue.</Text>

      <Pressable style={styles.primaryButton} onPress={() => onSelectRole('company')}>
        <Text style={styles.primaryButtonText}>I am a Security Company</Text>
      </Pressable>

      <Pressable style={styles.secondaryButton} onPress={() => onSelectRole('guard')}>
        <Text style={styles.secondaryButtonText}>I am a Security Guard</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#f9fafb',
    gap: 12,
  },
  title: { fontSize: 28, fontWeight: '700', textAlign: 'center', color: '#111827' },
  subtitle: { fontSize: 16, textAlign: 'center', color: '#4b5563', marginBottom: 8 },
  primaryButton: {
    width: '100%',
    backgroundColor: '#111827',
    paddingVertical: 14,
    borderRadius: 10,
  },
  primaryButtonText: {
    color: '#fff',
    fontWeight: '700',
    textAlign: 'center',
  },
  secondaryButton: {
    width: '100%',
    backgroundColor: '#e5e7eb',
    paddingVertical: 14,
    borderRadius: 10,
  },
  secondaryButtonText: {
    color: '#111827',
    fontWeight: '700',
    textAlign: 'center',
  },
});
