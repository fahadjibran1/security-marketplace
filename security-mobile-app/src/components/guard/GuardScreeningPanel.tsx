import React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { acceptMyScreeningConsent, addMyScreeningAddress, addMyScreeningHistory, addMyScreeningReference, completeMyScreeningEvidence, createMyScreeningEvidence, getMyScreening, startMyScreening, submitMyScreening, updateMyScreeningProfile, withdrawMyScreeningConsent } from '../../services/api';
import { GuardScreening } from '../../types/models';
import { colors } from '../../theme';

export function GuardScreeningPanel(){
 const [data,setData]=React.useState<GuardScreening|null>(null);const [error,setError]=React.useState('');const [busy,setBusy]=React.useState(false);
 const [profile,setProfile]=React.useState({legalFullName:'',dateOfBirth:'',nationality:'',currentAddress:''});
 const [history,setHistory]=React.useState({type:'EMPLOYMENT',startDate:'',endDate:'',organisation:'',description:''});
 const [address,setAddress]=React.useState({address:'',startDate:'',endDate:''});
 const [reference,setReference]=React.useState({historyId:'',organisation:'',contactPerson:'',relationship:'',businessEmail:'',phone:''});
 const [file,setFile]=React.useState({category:'identity',sourceUri:''});
 const load=React.useCallback(()=>getMyScreening().then(setData).catch(e=>setError(e.message||'Unable to load screening.')),[]);React.useEffect(()=>{load();},[load]);
 const act=async(fn:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await fn();await load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 const sections=['Personal details','Identity','Address history',`${data?.screeningPeriodYears||5}-year history`,'References','SIA licence','Right to Work','Supporting evidence','Consent','Final review'];
 return <View style={s.card}><Text style={s.title}>Screening & Vetting</Text><Text style={s.note}>Account access is separate from screening. Only an authorised reviewer can set VETTED.</Text>
  <Text style={s.progress}>{data?.progress||0}% · {data?.status||'NOT_STARTED'}</Text>
  <View style={s.sections}>{sections.map(x=><Text key={x} style={s.section}>• {x}</Text>)}</View>
  {(data?.status==='NOT_STARTED'||!data?.id)?<Pressable disabled={busy} style={s.button} onPress={()=>act(()=>startMyScreening())}><Text style={s.buttonText}>Start screening file</Text></Pressable>:null}
  {data?.id&&['IN_PROGRESS','REQUIRES_ATTENTION'].includes(data.status)?<>
   <Text style={s.heading}>Personal details</Text>{Object.keys(profile).map(k=><TextInput key={k} placeholder={k.replace(/([A-Z])/g,' $1')} value={(profile as any)[k]} onChangeText={(v:string)=>setProfile({...profile,[k]:v})} style={s.input}/>)}
   <Pressable style={s.button} onPress={()=>act(()=>updateMyScreeningProfile(profile))}><Text style={s.buttonText}>Save personal details</Text></Pressable>
   <Text style={s.heading}>Add chronology period</Text>{Object.keys(history).map(k=><TextInput key={k} placeholder={k.replace(/([A-Z])/g,' $1')} value={(history as any)[k]} onChangeText={(v:string)=>setHistory({...history,[k]:v})} style={s.input}/>)}
   <Pressable style={s.button} onPress={()=>act(()=>addMyScreeningHistory({...history,isCurrent:!history.endDate,endDate:history.endDate||undefined}))}><Text style={s.buttonText}>Add history period</Text></Pressable>
   <Text style={s.heading}>Add address period</Text>{Object.keys(address).map(k=><TextInput key={k} placeholder={k.replace(/([A-Z])/g,' $1')} value={(address as any)[k]} onChangeText={(v:string)=>setAddress({...address,[k]:v})} style={s.input}/>)}
   <Pressable style={s.button} onPress={()=>act(()=>addMyScreeningAddress({...address,isCurrent:!address.endDate,endDate:address.endDate||undefined}))}><Text style={s.buttonText}>Add address</Text></Pressable>
   <Text style={s.heading}>Add referee (linked history ID)</Text>{Object.keys(reference).map(k=><TextInput key={k} placeholder={k.replace(/([A-Z])/g,' $1')} value={(reference as any)[k]} onChangeText={(v:string)=>setReference({...reference,[k]:v})} style={s.input}/>)}
   <Text style={s.note}>History IDs: {(data.history||[]).map(h=>`${h.id} ${h.type}`).join(' · ')||'add history first'}</Text>
   <Pressable style={s.button} onPress={()=>act(()=>addMyScreeningReference({...reference,historyId:Number(reference.historyId)}))}><Text style={s.buttonText}>Add referee</Text></Pressable>
   <Text style={s.heading}>Private supporting evidence</Text><TextInput placeholder="Category: identity, address, employment, reference, right_to_work or sia" value={file.category} onChangeText={(v:string)=>setFile({...file,category:v})} style={s.input}/><TextInput placeholder="Local file URI or HTTPS source (not stored)" value={file.sourceUri} onChangeText={(v:string)=>setFile({...file,sourceUri:v})} style={s.input}/>
   <Pressable style={s.button} onPress={()=>act(async()=>{const source=await fetch(file.sourceUri.trim());if(!source.ok)throw new Error('Unable to read selected evidence.');const blob=await source.blob();const name=decodeURIComponent(file.sourceUri.split('/').pop()?.split('?')[0]||'evidence');const created=await createMyScreeningEvidence({category:file.category,originalFileName:name,mimeType:blob.type,sizeBytes:blob.size});const uploaded=await fetch(created.upload.url,{method:created.upload.method,headers:created.upload.headers,body:blob});if(!uploaded.ok)throw new Error('Private evidence upload failed.');await completeMyScreeningEvidence(created.id);})}><Text style={s.buttonText}>Upload private evidence</Text></Pressable>
   <Pressable style={s.secondary} onPress={()=>act(()=>acceptMyScreeningConsent())}><Text style={s.secondaryText}>Accept screening and referee-contact consent</Text></Pressable>
   <Pressable style={s.secondary} onPress={()=>act(()=>withdrawMyScreeningConsent())}><Text style={s.secondaryText}>Withdraw current screening consent</Text></Pressable>
   <Pressable style={s.button} onPress={()=>act(()=>submitMyScreening())}><Text style={s.buttonText}>Submit for final review</Text></Pressable>
  </>:null}
  {data?.requirements?.missing.map(x=><Text key={x} style={s.missing}>Required: {x}</Text>)}
  {data?.requirements?.chronology.gaps.map(g=><Text key={`${g.from}-${g.to}`} style={s.missing}>Unexplained gap: {g.from} to {g.to}</Text>)}
  {error?<Text style={s.error}>{error}</Text>:null}
 </View>;
}
const s=StyleSheet.create({card:{backgroundColor:'#fff',borderWidth:1,borderColor:colors.border,borderRadius:14,padding:16,gap:10},title:{fontSize:20,fontWeight:'800',color:colors.textPrimary},note:{color:colors.textSecondary,lineHeight:20},progress:{fontWeight:'800',color:colors.primaryNavy},sections:{flexDirection:'row',flexWrap:'wrap',gap:8},section:{color:colors.textSecondary,minWidth:140},heading:{fontWeight:'800',marginTop:8,color:colors.textPrimary},input:{borderWidth:1,borderColor:colors.border,borderRadius:8,padding:10},button:{backgroundColor:colors.primaryNavy,borderRadius:8,padding:11,alignItems:'center'},buttonText:{color:'#fff',fontWeight:'800'},secondary:{borderWidth:1,borderColor:colors.primaryNavy,borderRadius:8,padding:11},secondaryText:{color:colors.primaryNavy,fontWeight:'700'},missing:{color:'#9A3412'},error:{color:'#991B1B'}});
