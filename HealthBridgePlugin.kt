package app.biobalanca

import android.content.Intent
import android.net.Uri
import androidx.activity.result.ActivityResult
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.BasalMetabolicRateRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.BodyWaterMassRecord
import androidx.health.connect.client.records.BoneMassRecord
import androidx.health.connect.client.records.HeightRecord
import androidx.health.connect.client.records.LeanBodyMassRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.time.Instant
import kotlin.reflect.KClass

/**
 * Ponte entre o Bio Balança e o Health Connect do Android.
 * Lê as medições de composição corporal que o Samsung Health (Galaxy Watch) grava lá.
 */
@CapacitorPlugin(name = "HealthBridge")
class HealthBridgePlugin : Plugin() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val provider = "com.google.android.apps.healthdata"

    private val recordTypes: List<KClass<out Record>> = listOf(
        BodyFatRecord::class,
        WeightRecord::class,
        LeanBodyMassRecord::class,
        BodyWaterMassRecord::class,
        BoneMassRecord::class,
        BasalMetabolicRateRecord::class,
        HeightRecord::class,
    )
    private val readPermissions: Set<String> =
        recordTypes.map { HealthPermission.getReadPermission(it) }.toSet()

    private fun sdkStatus(): Int = HealthConnectClient.getSdkStatus(context, provider)

    private fun statusInto(ret: JSObject, granted: Set<String>) {
        ret.put("granted", granted.containsAll(readPermissions))
        ret.put("grantedAny", granted.contains(HealthPermission.getReadPermission(BodyFatRecord::class)))
    }

    /** Diz se o Health Connect existe neste celular e se o app já tem permissão. */
    @PluginMethod
    fun status(call: PluginCall) {
        val st = sdkStatus()
        val ret = JSObject()
        ret.put("available", st == HealthConnectClient.SDK_AVAILABLE)
        ret.put("needsUpdate", st == HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED)
        if (st != HealthConnectClient.SDK_AVAILABLE) {
            ret.put("granted", false)
            ret.put("grantedAny", false)
            call.resolve(ret)
            return
        }
        scope.launch {
            try {
                val granted = HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions()
                statusInto(ret, granted)
                call.resolve(ret)
            } catch (e: Exception) {
                call.reject(e.message ?: "Erro ao consultar o Health Connect")
            }
        }
    }

    /** Abre a tela do Health Connect para o usuário permitir a leitura. */
    @PluginMethod
    fun authorize(call: PluginCall) {
        if (sdkStatus() != HealthConnectClient.SDK_AVAILABLE) {
            call.reject("Health Connect indisponível")
            return
        }
        try {
            val contract = PermissionController.createRequestPermissionResultContract(provider)
            val intent = contract.createIntent(context, readPermissions)
            startActivityForResult(call, intent, "authorizeResult")
        } catch (e: Exception) {
            call.reject(e.message ?: "Não foi possível pedir a permissão")
        }
    }

    @ActivityCallback
    fun authorizeResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        scope.launch {
            val ret = JSObject()
            ret.put("available", true)
            try {
                val granted = HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions()
                statusInto(ret, granted)
            } catch (e: Exception) {
                ret.put("granted", false)
                ret.put("grantedAny", false)
            }
            call.resolve(ret)
        }
    }

    /** Lê as medições a partir de `since` (milissegundos). */
    @PluginMethod
    fun read(call: PluginCall) {
        val since = (call.getDouble("since") ?: 0.0).toLong()
        scope.launch {
            try {
                val client = HealthConnectClient.getOrCreate(context)
                val granted = client.permissionController.getGrantedPermissions()
                val filter = TimeRangeFilter.after(Instant.ofEpochMilli(since))
                val out = JSArray()

                suspend fun <T : Record> readAll(type: KClass<T>): List<T> {
                    if (!granted.contains(HealthPermission.getReadPermission(type))) return emptyList()
                    val list = mutableListOf<T>()
                    var token: String? = null
                    do {
                        val resp = client.readRecords(ReadRecordsRequest(type, filter, pageToken = token))
                        list.addAll(resp.records)
                        token = resp.pageToken
                    } while (token != null)
                    return list
                }

                readAll(BodyFatRecord::class).forEach { out.put(item("fat", it.time, it.percentage.value, it.metadata)) }
                readAll(WeightRecord::class).forEach { out.put(item("weight", it.time, it.weight.inKilograms, it.metadata)) }
                readAll(LeanBodyMassRecord::class).forEach { out.put(item("lean", it.time, it.mass.inKilograms, it.metadata)) }
                readAll(BodyWaterMassRecord::class).forEach { out.put(item("water", it.time, it.mass.inKilograms, it.metadata)) }
                readAll(BoneMassRecord::class).forEach { out.put(item("bone", it.time, it.mass.inKilograms, it.metadata)) }
                readAll(BasalMetabolicRateRecord::class).forEach { out.put(item("bmr", it.time, it.basalMetabolicRate.inKilocaloriesPerDay, it.metadata)) }
                readAll(HeightRecord::class).forEach { out.put(item("height", it.time, it.height.inMeters, it.metadata)) }

                val ret = JSObject()
                ret.put("records", out)
                call.resolve(ret)
            } catch (e: Exception) {
                call.reject(e.message ?: "Erro ao ler o Health Connect")
            }
        }
    }

    /** Abre as configurações do Health Connect (ou a loja, se precisar instalar/atualizar). */
    @PluginMethod
    fun openSettings(call: PluginCall) {
        try {
            val intent = if (sdkStatus() == HealthConnectClient.SDK_AVAILABLE) {
                Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS)
            } else {
                Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$provider&url=healthconnect%3A%2F%2Fonboarding"))
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject(e.message ?: "Não foi possível abrir o Health Connect")
        }
    }

    private fun item(type: String, time: Instant, value: Double, md: Metadata): JSObject {
        val o = JSObject()
        o.put("type", type)
        o.put("t", time.toEpochMilli())
        o.put("v", value)
        o.put("src", md.dataOrigin.packageName)
        o.put("dev", md.device?.type ?: 0)
        return o
    }
}
