// Monta o app Android do Bio Balança.
//   node setup-android.mjs www      -> copia os arquivos do app web para a pasta www/
//   node setup-android.mjs android  -> ajusta o projeto gerado por "npx cap add android"
// Usado pelo workflow do GitHub (.github/workflows/android.yml).
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const mode = process.argv[2];
const WEB = ['index.html', 'manifest.json', 'sw.js', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];

function edit(file, fn) {
  const p = path.join(root, file);
  const before = fs.readFileSync(p, 'utf8');
  const after = fn(before);
  if (after === before) throw new Error(`Nada mudou em ${file}: o modelo do Capacitor pode ter mudado.`);
  fs.writeFileSync(p, after);
  console.log('ajustado', file);
}
function mustReplace(text, find, repl, label) {
  if (!text.includes(find)) throw new Error(`Trecho não encontrado (${label}): ${find}`);
  return text.replace(find, repl);
}

if (mode === 'www') {
  fs.mkdirSync(path.join(root, 'www'), { recursive: true });
  for (const f of WEB) fs.copyFileSync(path.join(root, f), path.join(root, 'www', f));
  // versão e repositório (usados pelo aviso de versão nova); preenchidos pelo GitHub Actions
  const repo = process.env.GITHUB_REPOSITORY, run = process.env.GITHUB_RUN_NUMBER;
  if (repo && run) {
    const p = path.join(root, 'www', 'index.html');
    const html = fs.readFileSync(p, 'utf8').replace('<script>',
      `<script>window.APP_BUILD=${JSON.stringify({ repo, version: '1.0.' + run })};</script>\n<script>`);
    fs.writeFileSync(p, html);
    console.log('versão 1.0.' + run + ' de ' + repo);
  }
  console.log('www/ pronto');
  process.exit(0);
}

if (mode !== 'android') {
  console.error('uso: node setup-android.mjs www|android');
  process.exit(1);
}

const KOTLIN = '2.2.20';
const app = 'android/app';
const pkgDir = `${app}/src/main/java/app/biobalanca`;

// 1) Versão mínima do Android exigida pelo Health Connect (8.0)
edit('android/variables.gradle', t => t.replace(/minSdkVersion = \d+/, 'minSdkVersion = 26'));

// 2) Kotlin no projeto (o plugin do Health Connect é em Kotlin)
edit('android/build.gradle', t => mustReplace(t,
  "classpath 'com.android.tools.build:gradle:",
  `classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:${KOTLIN}"\n        classpath 'com.android.tools.build:gradle:`,
  'classpath'));
edit('android/variables.gradle', t => t.replace(/ext \{/, `ext {\n    kotlin_version = '${KOTLIN}'`));

// 3) Módulo do app: Kotlin, Health Connect, assinatura fixa e número de versão
edit(`${app}/build.gradle`, t => {
  t = 'import org.jetbrains.kotlin.gradle.dsl.JvmTarget\n\n' + t;
  t = mustReplace(t, "apply plugin: 'com.android.application'",
    "apply plugin: 'com.android.application'\napply plugin: 'kotlin-android'", 'kotlin plugin');
  const run = 'System.getenv("GITHUB_RUN_NUMBER") ?: "1"';
  t = t.replace(/versionCode \d+/, `versionCode((${run}).toInteger())`);
  t = t.replace(/versionName "[^"]*"/, `versionName("1.0." + (${run}))`);
  t = mustReplace(t, '    buildTypes {',
`    signingConfigs {
        // Chave fixa: assim cada nova versão instala por cima da anterior sem perder os dados
        fixa {
            storeFile file('../../bio-balanca.keystore')
            storePassword 'biobalanca'
            keyAlias 'biobalanca'
            keyPassword 'biobalanca'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.fixa
        }`, 'signing');
  t = mustReplace(t, 'dependencies {',
`kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_21
    }
}

dependencies {
    implementation "androidx.health.connect:connect-client:1.1.+"
    implementation "org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2"
    implementation "org.jetbrains.kotlin:kotlin-stdlib:${KOTLIN}"`, 'dependencies');
  return t;
});

// 4) Manifesto: permissões do Health Connect e telas exigidas por ele
edit(`${app}/src/main/AndroidManifest.xml`, t => {
  const perms = ['BODY_FAT', 'WEIGHT', 'LEAN_BODY_MASS', 'BODY_WATER_MASS', 'BONE_MASS', 'BASAL_METABOLIC_RATE', 'HEIGHT']
    .map(p => `    <uses-permission android:name="android.permission.health.READ_${p}" />`).join('\n')
    + '\n    <uses-permission android:name="android.permission.health.WRITE_WEIGHT" />';
  t = mustReplace(t, '<uses-permission android:name="android.permission.INTERNET" />',
`<uses-permission android:name="android.permission.INTERNET" />
${perms}

    <queries>
        <package android:name="com.google.android.apps.healthdata" />
    </queries>`, 'permissões');
  // Android 13 ou anterior: tela de explicação das permissões
  t = mustReplace(t, `            <intent-filter>
                <action android:name="android.intent.action.MAIN" />`,
`            <intent-filter>
                <action android:name="androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE" />
            </intent-filter>

            <intent-filter>
                <action android:name="android.intent.action.MAIN" />`, 'rationale');
  // Android 14 ou superior
  t = mustReplace(t, '        <provider',
`        <activity-alias
            android:name="ViewPermissionUsageActivity"
            android:exported="true"
            android:targetActivity=".MainActivity"
            android:permission="android.permission.START_VIEW_PERMISSION_USAGE">
            <intent-filter>
                <action android:name="android.intent.action.VIEW_PERMISSION_USAGE" />
                <category android:name="android.intent.category.HEALTH_PERMISSIONS" />
            </intent-filter>
        </activity-alias>

        <provider`, 'alias');
  return t;
});

// 5) Plugin nativo do Health Connect + registro na tela principal
fs.copyFileSync(path.join(root, 'HealthBridgePlugin.kt'), path.join(root, pkgDir, 'HealthBridgePlugin.kt'));
fs.writeFileSync(path.join(root, pkgDir, 'MainActivity.java'),
`package app.biobalanca;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HealthBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`);
console.log('plugin HealthBridge instalado');

// 6) Ícone e abertura escura (no lugar do logo do Capacitor)
const res = `${app}/src/main/res`;
fs.rmSync(path.join(root, res, 'mipmap-anydpi-v26'), { recursive: true, force: true });
for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
  const src = ['xxhdpi', 'xxxhdpi'].includes(d) ? 'icon-512.png' : 'icon-192.png';
  for (const n of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
    const dest = path.join(root, res, `mipmap-${d}`, n);
    if (fs.existsSync(path.dirname(dest))) fs.copyFileSync(path.join(root, src), dest);
  }
}
// ícone pequeno (branco) das notificações de lembrete
fs.mkdirSync(path.join(root, res, 'drawable'), { recursive: true });
fs.writeFileSync(path.join(root, res, 'drawable', 'ic_stat_balanca.xml'),
`<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
    <path android:fillColor="#FFFFFFFF" android:pathData="M5,3h14a2,2 0,0 1,2 2v14a2,2 0,0 1,-2 2H5a2,2 0,0 1,-2 -2V5a2,2 0,0 1,2 -2zM12,7a5,5 0,0 0,-4.6 3l1.8,0.8A3,3 0,0 1,12 9a3,3 0,0 1,2.4 1.2l-2.3,2.3 1.4,1.4 3,-3A5,5 0,0 0,12 7z"/>
</vector>
`);

edit(`${res}/values/styles.xml`, t => mustReplace(t,
  '<item name="android:background">@drawable/splash</item>',
  '<item name="android:background">#0b0f14</item>', 'splash'));

console.log('Projeto Android pronto.');
